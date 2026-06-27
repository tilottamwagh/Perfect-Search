require('dotenv').config();
const { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText } = require('./prompt');
const logger = require('../utils/logger');

// DeepSeek — OpenAI-compatible chat-completions API at api.deepseek.com.
// One key, several models (v4 flash/pro + legacy chat/reasoner). Cheap, and
// deepseek-reasoner is a strong thinking model. No server-side web search,
// so Web Research surfaces the same friendly notice as OpenAI.
const DEFAULT_MODEL = process.env.OMNISEARCH_DEEPSEEK_MODEL || 'deepseek-v4-pro';
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const API_URL = `${BASE_URL}/chat/completions`;

// Mirrors api-docs.deepseek.com. The bare `deepseek-chat` / `deepseek-reasoner`
// aliases are slated for deprecation (2026-07-24) and map to v4-flash
// non-thinking / thinking modes respectively — kept for back-compat.
const MODELS = [
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — strongest, recommended', tier: 'premium', supportsWeb: false },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — fast & cheap', tier: 'standard', supportsWeb: false },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner — thinking mode (legacy alias)', tier: 'premium', supportsWeb: false },
    { id: 'deepseek-chat', label: 'DeepSeek Chat — non-thinking (legacy alias)', tier: 'standard', supportsWeb: false },
];

const META = {
    id: 'deepseek',
    name: 'DeepSeek',
    color: 'cyan',
    keyPrefix: 'sk-',
    keyHelp: 'Get a key at platform.deepseek.com → API keys. OpenAI-compatible; very cheap per-token pricing (see api-docs.deepseek.com/quick_start/pricing).',
    pricing: 'paid · very cheap per-token',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    // No native web search, but shared DuckDuckGo fallback in webSearch.js.
    supportsWeb: true,
};

async function testKey(apiKey, model) {
    const modelId = model || DEFAULT_MODEL;
    try {
        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: modelId,
                max_tokens: 24,
                messages: [{ role: 'user', content: 'Say hi.' }],
            }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            return { ok: false, error: `HTTP ${resp.status}: ${body.substring(0, 200)}` };
        }
        // A 200 with a well-formed choices array means the key authenticated and
        // the model exists — that's all we need to confirm. Don't require any
        // specific reply text: reasoning models can put their output in
        // reasoning_content, and a tight token budget can truncate content.
        const data = await resp.json();
        const ok = Array.isArray(data?.choices) && data.choices.length > 0;
        return { ok, model: modelId, error: ok ? undefined : 'Unexpected response shape from DeepSeek' };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

// OpenAI-protocol SSE parser (DeepSeek uses the identical wire format).
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
    const picked = Array.isArray(prePicked) ? prePicked : selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;

    const userText = buildUserMessage(query, picked);
    const sysText = (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.length > 0) ? systemPrompt : SYSTEM_PROMPT;
    logger.info('Phase 6', `[deepseek:${modelId}] sources=${picked.length} prompt=${userText.length} chars system=${sysText.length} chars`);
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

    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`DeepSeek HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let fullText = '';
    let usage = null;
    for await (const chunk of sseLines(resp)) {
        // deepseek-reasoner streams its chain-of-thought in `reasoning_content`;
        // we only surface the final `content` to the user.
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            if (onChunk) try { onChunk(delta); } catch (_) {}
        }
        if (chunk?.usage) usage = chunk.usage;
    }

    const elapsed = Date.now() - startedAt;
    // Never record zero — estimate from chars (~4/token) if the API omitted usage.
    let finalUsage;
    if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
        finalUsage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens };
    } else {
        const inEst = Math.ceil((sysText.length + userText.length) / 4);
        const outEst = Math.ceil(fullText.length / 4);
        finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
    }
    logger.success('Phase 6', `[deepseek:${modelId}] done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}${finalUsage.estimated ? ' (est)' : ''}`);

    return { text: fullText, picked, usage: finalUsage, model: modelId, elapsedMs: elapsed };
}

// DeepSeek has no native web search — use the shared DuckDuckGo fallback.
async function synthesizeWithWeb({ query, apiKey, onChunk, model }) {
    const { webResearch } = require('./webSearch');
    return webResearch({ adapter: module.exports, query, apiKey, model: model || DEFAULT_MODEL, onChunk });
}

// Non-streaming chat helper for the agent's intent classifier.
async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const modelId = model || DEFAULT_MODEL;
    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: modelId,
            max_tokens: maxTokens,
            temperature: 0.1,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        }),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`DeepSeek chat HTTP ${resp.status}: ${errBody.substring(0, 200)}`);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
}

// Text-only ServiceNow case analysis. DeepSeek's chat API doesn't accept
// image inputs, so we analyze the case record + comments + text attachments
// and note that screenshots were skipped — rather than failing outright like
// the old "switch to OpenAI" error did. For full screenshot analysis the user
// can still switch to OpenAI (vision), but DeepSeek covers the text case.
async function analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    let text = buildCaseAnalysisText(caseBundle, kbResults);
    const imageCount = Array.isArray(caseBundle?.images) ? caseBundle.images.length : 0;
    if (imageCount > 0) {
        text += `\n\n(NOTE: ${imageCount} screenshot(s) were attached to this case but DeepSeek can't read images. Analyze from the text above; if a screenshot is critical, the user can switch the active provider to OpenAI for vision.)`;
    }

    logger.info('Phase 7', `[deepseek:${modelId}] analyzeCase prompt=${text.length} chars, images=${imageCount} (skipped), kb=${(kbResults || []).length}`);
    const startedAt = Date.now();

    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
        throw new Error(`DeepSeek HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
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
    logger.success('Phase 7', `[deepseek:${modelId}] analyzeCase done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}`);
    return { text: fullText, usage: finalUsage, model: modelId, elapsedMs: elapsed };
}

// Multi-turn streaming chat for "Ask AI Expert". DeepSeek's chat-completions
// is OpenAI-compatible; image_url parts are dropped since DeepSeek is
// text-only — a marker line is appended so the model knows screenshots existed.
async function expertChat({ messages, systemPrompt, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    const normalized = (messages || []).map((m) => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content };
        const textParts = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text);
        const imageCount = (m.content || []).filter((b) => b.type === 'image_url').length;
        let joined = textParts.join('\n');
        if (imageCount > 0) joined += `\n\n(${imageCount} image(s) attached — DeepSeek is text-only; describe them in text if needed.)`;
        return { role: m.role, content: joined };
    });

    const startedAt = Date.now();
    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
        throw new Error(`DeepSeek HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
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
