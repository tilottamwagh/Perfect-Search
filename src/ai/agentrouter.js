require('dotenv').config();
const { net } = require('electron');
const { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText } = require('./prompt');
const logger = require('../utils/logger');

// Agent Router's anti-bot middleware does TLS fingerprinting (JA3/JA4). The
// global `fetch()` in Electron's main process is backed by Node's undici,
// which has a distinct TLS handshake signature that gets blocked. Roo Code
// works against the same endpoint because it runs requests through
// Chromium's network stack (Chrome TLS fingerprint), which is what
// `electron.net.fetch` does — same API as global fetch but Chromium-backed.
//
// Use this everywhere in this file, never the global fetch.
const chromiumFetch = (url, opts) => net.fetch(url, opts);

// Agent Router (agentrouter.org) is a multi-provider proxy that exposes
// Anthropic, DeepSeek, and Zhipu AI models behind a single OpenAI-style
// chat-completions endpoint. One API key, one base URL, many models —
// useful when you want to compare providers without juggling separate keys
// or get cheaper rates than the upstream provider.
//
// Default base URL can be overridden via env var (or, in the future, via
// per-source settings) if Agent Router changes hosts or you proxy it.
const DEFAULT_MODEL = process.env.OMNISEARCH_AGENTROUTER_MODEL || 'claude-opus-4-6';
const BASE_URL = process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org/v1';
const API_URL = `${BASE_URL}/chat/completions`;

// Agent Router's edge sits behind anti-bot middleware that rejects raw
// Node fetch requests. Three things triggered the previous "unauthorized
// client" 401:
//   1. The default `undici/x.x` User-Agent is blocked outright.
//   2. The word "Electron" in our previous UA is on most scraper blocklists.
//   3. Setting `HTTP-Referer` to a github.com URL triggers an origin check.
//
// Roo Code (which works against the same endpoint with the same key) just
// sends a plain Chrome-like User-Agent, so we do the same here.
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/event-stream',
};

// Model list mirrors the agentrouter.org/pricing page. Each carries a hint
// about which upstream provider it routes to so the user can pick by
// quality vs. cost intent. Update this list as Agent Router adds models.
const MODELS = [
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 — top reasoning, premium price', tier: 'premium', supportsWeb: false, upstream: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast Anthropic model, cheap', tier: 'standard', supportsWeb: false, upstream: 'anthropic' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek v4 Pro — strong open-weights model', tier: 'standard', supportsWeb: false, upstream: 'deepseek' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek v4 Flash — fast & cheap', tier: 'fast', supportsWeb: false, upstream: 'deepseek' },
    { id: 'glm-5.1', label: 'GLM 5.1 — Zhipu AI flagship', tier: 'standard', supportsWeb: false, upstream: 'zhipu' },
];

const META = {
    id: 'agentrouter',
    name: 'Agent Router',
    color: 'sky',
    keyPrefix: 'sk-',
    keyHelp: 'Get a key at agentrouter.org. Acts as a proxy for Claude, DeepSeek, and Zhipu models — one key, many models. Pricing varies per model on agentrouter.org/pricing.',
    pricing: 'paid · per-model, see agentrouter.org/pricing',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    // No native web search, but shared DuckDuckGo fallback in webSearch.js.
    supportsWeb: true,
};

async function testKey(apiKey) {
    try {
        const resp = await chromiumFetch(API_URL, {
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: DEFAULT_MODEL,
                max_tokens: 16,
                messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
            }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            // Translate the common "unauthorized_client" 401 into actionable
            // guidance — it usually means the proxy's anti-bot filter is
            // still blocking us, not that the key is wrong.
            if (resp.status === 401 && /unauthorized_client|unauthorized client/i.test(body)) {
                return {
                    ok: false,
                    error: `Agent Router rejected this client (HTTP 401 unauthorized_client). The key may be valid but their anti-bot filter is blocking the request. Try: (1) confirming the key on agentrouter.org/console, (2) checking if your account region matches the endpoint, or (3) joining their Discord (link in error body) and asking them to whitelist OpenAI-SDK-style clients.`,
                };
            }
            return { ok: false, error: `HTTP ${resp.status}: ${body.substring(0, 200)}` };
        }
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || '';
        return { ok: /ok/i.test(text), model: DEFAULT_MODEL };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

// Identical SSE parser to the OpenAI adapter — Agent Router uses the same
// streaming wire format because it's OpenAI-protocol-compatible.
async function* sseLines(resp) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const raw of block.split('\n')) {
                if (!raw.startsWith('data:')) continue;
                const payload = raw.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try { yield JSON.parse(payload); } catch (_) {}
            }
        }
    }
}

async function synthesize({ query, results, apiKey, onChunk, model, systemPrompt, picked: prePicked }) {
    // Phase 2: ai/index.js pre-selects + enriches; use that if provided.
    const picked = Array.isArray(prePicked) ? prePicked : selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;

    const userText = buildUserMessage(query, picked);
    // Phase-1 agent integration: caller may pass a dynamically-composed
    // system prompt. Falls back to the static SYSTEM_PROMPT when the agent
    // layer is bypassed.
    const sysText = (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.length > 0) ? systemPrompt : SYSTEM_PROMPT;
    logger.info('Phase 6', `[agentrouter:${modelId}] sources=${picked.length} prompt=${userText.length} chars system=${sysText.length} chars`);
    const startedAt = Date.now();

    const reqBody = {
        model: modelId,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 4096,
        temperature: 0.4,
        messages: [
            { role: 'system', content: sysText },
            { role: 'user', content: userText },
        ],
    };

    const resp = await chromiumFetch(API_URL, {
        method: 'POST',
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        if (resp.status === 401 && /unauthorized_client|unauthorized client/i.test(errBody)) {
            throw new Error('Agent Router rejected this client (401 unauthorized_client). The key may be valid but their anti-bot filter blocked the request. Check agentrouter.org/console for key status and account region.');
        }
        throw new Error(`Agent Router HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let fullText = '';
    let usage = null;
    for await (const chunk of sseLines(resp)) {
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            if (onChunk) try { onChunk(delta); } catch (_) {}
        }
        if (chunk?.usage) usage = chunk.usage;
    }

    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[agentrouter:${modelId}] done in ${elapsed}ms · in=${usage?.prompt_tokens} out=${usage?.completion_tokens}`);

    return {
        text: fullText,
        picked,
        usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
        model: modelId,
        elapsedMs: elapsed,
    };
}

// Agent Router has no native web search — use the shared DuckDuckGo fallback.
async function synthesizeWithWeb({ query, apiKey, onChunk, model }) {
    const { webResearch } = require('./webSearch');
    return webResearch({ adapter: module.exports, query, apiKey, model: model || DEFAULT_MODEL, onChunk });
}

// Lightweight non-streaming chat helper for the agent's intent classifier.
// Reuses the Chromium-routed fetch + browser headers used by synthesize so
// the same anti-bot bypass applies.
async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const modelId = model || DEFAULT_MODEL;
    const reqBody = {
        model: modelId,
        max_tokens: maxTokens,
        temperature: 0.1,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    };
    const resp = await chromiumFetch(API_URL, {
        method: 'POST',
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Agent Router chat HTTP ${resp.status}: ${errBody.substring(0, 200)}`);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
}

// ServiceNow case analysis. AgentRouter is OpenAI-compatible but its upstream
// routing varies per model, so we play it safe and analyze text-only with a
// note that screenshots were skipped.
async function analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    let text = buildCaseAnalysisText(caseBundle, kbResults);
    const imageCount = Array.isArray(caseBundle?.images) ? caseBundle.images.length : 0;
    if (imageCount > 0) {
        text += `\n\n(NOTE: ${imageCount} screenshot(s) attached — image analysis depends on the upstream model. Switch to OpenAI / Anthropic / Gemini / Bedrock for guaranteed vision.)`;
    }

    logger.info('Phase 7', `[agentrouter:${modelId}] analyzeCase prompt=${text.length} chars, images=${imageCount} (text-only), kb=${(kbResults || []).length}`);
    const startedAt = Date.now();

    const resp = await chromiumFetch(API_URL, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: modelId,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 4096,
            temperature: 0.3,
            messages: [
                { role: 'system', content: CASE_ANALYSIS_SYSTEM_PROMPT },
                { role: 'user', content: text },
            ],
        }),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Agent Router HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let fullText = '';
    let usage = null;
    for await (const chunk of sseLines(resp)) {
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            if (onChunk) try { onChunk(delta); } catch (_) {}
        }
        if (chunk?.usage) usage = chunk.usage;
    }

    const elapsed = Date.now() - startedAt;
    let finalUsage;
    if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
        finalUsage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens };
    } else {
        const inEst = Math.ceil(text.length / 4);
        const outEst = Math.ceil(fullText.length / 4);
        finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
    }
    logger.success('Phase 7', `[agentrouter:${modelId}] analyzeCase done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}`);
    return { text: fullText, usage: finalUsage, model: modelId, elapsedMs: elapsed };
}

// Multi-turn streaming chat for "Ask AI Expert".
async function expertChat({ messages, systemPrompt, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    const normalized = (messages || []).map((m) => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content };
        const textParts = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text);
        const imageCount = (m.content || []).filter((b) => b.type === 'image_url').length;
        let joined = textParts.join('\n');
        if (imageCount > 0) joined += `\n\n(${imageCount} image(s) attached — Agent Router upstream support for vision varies.)`;
        return { role: m.role, content: joined };
    });

    const startedAt = Date.now();
    const resp = await chromiumFetch(API_URL, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: modelId,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 4096,
            temperature: 0.4,
            messages: [
                { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
                ...normalized,
            ],
        }),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Agent Router HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let fullText = '';
    let usage = null;
    for await (const chunk of sseLines(resp)) {
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            if (onChunk) try { onChunk(delta); } catch (_) {}
        }
        if (chunk?.usage) usage = chunk.usage;
    }
    return {
        text: fullText,
        usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
        model: modelId,
        elapsedMs: Date.now() - startedAt,
    };
}

module.exports = { META, testKey, synthesize, synthesizeWithWeb, chat, analyzeCase, expertChat };
