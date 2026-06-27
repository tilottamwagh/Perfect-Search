require('dotenv').config();
const { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText } = require('./prompt');
const logger = require('../utils/logger');

// `gpt-4.1-mini` is the cheap workhorse in 2026 — replaces the older
// `gpt-4o-mini` as the default sweet-spot. Override via env if you want a
// different variant.
const DEFAULT_MODEL = process.env.OMNISEARCH_OPENAI_MODEL || 'gpt-4.1-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';

// Curated list of currently-available OpenAI chat-completions models.
// Updated June 2026. The o-series ("reasoning") models reject `temperature`
// and use `max_completion_tokens` instead of `max_tokens` — the synthesize
// function below detects them via the `/^o\d/` pattern.
const MODELS = [
    // GPT-5 family (current flagship — if your account has access)
    { id: 'gpt-5', label: 'GPT-5 — current flagship (if available on your account)', tier: 'premium', supportsWeb: false },
    { id: 'gpt-5-mini', label: 'GPT-5 mini — current sweet spot (if available)', tier: 'standard', supportsWeb: false },
    { id: 'gpt-5-nano', label: 'GPT-5 nano — current cheapest (if available)', tier: 'fast', supportsWeb: false },
    // GPT-4.1 family (widely available, recommended default)
    { id: 'gpt-4.1', label: 'GPT-4.1 — flagship, broad availability', tier: 'premium', supportsWeb: false },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini — recommended cheap workhorse', tier: 'standard', supportsWeb: false },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano — cheapest non-reasoning', tier: 'fast', supportsWeb: false },
    // GPT-4o family — proven, still cost-effective
    { id: 'gpt-4o', label: 'GPT-4o — proven multimodal flagship', tier: 'standard', supportsWeb: false },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini — proven cheap option', tier: 'fast', supportsWeb: false },
    // o-series reasoning models (slower, higher quality on logic / math)
    { id: 'o4-mini', label: 'o4-mini — newest small reasoning model', tier: 'standard', supportsWeb: false },
    { id: 'o3', label: 'o3 — full reasoning model', tier: 'premium', supportsWeb: false },
    { id: 'o3-mini', label: 'o3-mini — smaller reasoning model', tier: 'standard', supportsWeb: false },
    // Legacy — still works for users with older configs
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo — legacy, proven stable', tier: 'legacy', supportsWeb: false },
    { id: 'o1', label: 'o1 — legacy reasoning model', tier: 'legacy', supportsWeb: false },
    { id: 'o1-mini', label: 'o1-mini — legacy small reasoning', tier: 'legacy', supportsWeb: false },
];

const META = {
    id: 'openai',
    name: 'OpenAI',
    color: 'emerald',
    keyPrefix: 'sk-',
    keyHelp: 'Get a key at platform.openai.com/api-keys. Requires billing setup; gpt-4.1-mini is the cheap recommended workhorse.',
    pricing: 'paid · varies per model, see platform.openai.com/docs/pricing',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    // OpenAI chat-completions has no native web search, but we plug in the
    // shared DuckDuckGo fallback in webSearch.js so Web Research still works.
    supportsWeb: true,
};

async function testKey(apiKey) {
    try {
        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: DEFAULT_MODEL,
                max_completion_tokens: 16,
                messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
            }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            return { ok: false, error: `HTTP ${resp.status}: ${body.substring(0, 200)}` };
        }
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content || '';
        return { ok: /ok/i.test(text), model: DEFAULT_MODEL };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

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

async function synthesize({ query, results, apiKey, onChunk, model, systemPrompt, picked: prePicked, reasoning }) {
    // Phase 2: ai/index.js pre-selects + enriches; use that if provided.
    const picked = Array.isArray(prePicked) ? prePicked : selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;

    const userText = buildUserMessage(query, picked);
    // Phase-1 agent integration: caller may pass a dynamically-composed
    // system prompt. Falls back to the static SYSTEM_PROMPT when the agent
    // layer is bypassed.
    const sysText = (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.length > 0) ? systemPrompt : SYSTEM_PROMPT;
    logger.info('Phase 6', `[openai:${modelId}] sources=${picked.length} prompt=${userText.length} chars system=${sysText.length} chars`);
    const startedAt = Date.now();

    // Always use `max_completion_tokens` — it's the canonical OpenAI
    // parameter as of late 2025, supported across every current chat
    // model (gpt-4-turbo, gpt-4o, gpt-4.1, gpt-5, o-series). The older
    // `max_tokens` is deprecated and some newer model variants now
    // reject it outright with a 400. Always sending the new param is
    // future-proof.
    //
    // `temperature` is still tolerated everywhere, but o-series and
    // gpt-5 family ignore it. Skip sending it for those to avoid any
    // "unsupported parameter" surprises with future variants.
    const isReasoningModel = /^(o\d|gpt-5)/i.test(modelId);
    const reqBody = {
        model: modelId,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 4096,
        messages: [
            { role: 'system', content: sysText },
            { role: 'user', content: userText },
        ],
    };
    if (!isReasoningModel) reqBody.temperature = 0.4;
    // Reasoning effort (minimal/low/medium/high) — only for gpt-5 + o-series.
    // Higher = deeper thinking, slower, more tokens. Default medium.
    if (isReasoningModel && reasoning && ['minimal', 'low', 'medium', 'high'].includes(reasoning)) {
        reqBody.reasoning_effort = reasoning;
    }

    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`OpenAI HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
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

    // Some streamed responses (and some models) don't return a usage chunk
    // even with stream_options.include_usage. Rather than report null usage —
    // which makes the cost dashboard record nothing — estimate from character
    // counts (~4 chars per token is the standard rough heuristic). The result
    // is flagged `estimated:true` so the dashboard can mark it.
    let finalUsage;
    if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
        finalUsage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens };
    } else {
        const inEst = Math.ceil((sysText.length + userText.length) / 4);
        const outEst = Math.ceil(fullText.length / 4);
        finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
        logger.info('Phase 6', `[openai:${modelId}] no usage from API — estimated in≈${inEst} out≈${outEst}`);
    }
    logger.success('Phase 6', `[openai:${modelId}] done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}${finalUsage.estimated ? ' (est)' : ''}`);

    return {
        text: fullText,
        picked,
        usage: finalUsage,
        _origUsage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
        model: modelId,
        elapsedMs: elapsed,
    };
}

// Analyze a single ServiceNow case (the "✨ Analyze case" feature). Multimodal:
// the case text + knowledge-base context goes as a text part, and any attached
// screenshots go as image parts so the model can read error dialogs / stack
// traces. Vision is supported across current OpenAI chat models (gpt-5*,
// gpt-4.1*, gpt-4o*). Streams the diagnostic write-up via onChunk.
async function analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    const text = buildCaseAnalysisText(caseBundle, kbResults);
    const images = Array.isArray(caseBundle?.images) ? caseBundle.images : [];

    const userContent = [{ type: 'text', text }];
    for (const img of images) {
        const mime = img.contentType || 'image/png';
        userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${img.base64}` } });
    }

    logger.info('Phase 7', `[openai:${modelId}] analyzeCase prompt=${text.length} chars, images=${images.length}, kb=${(kbResults || []).length}`);
    const startedAt = Date.now();

    const rejectsTemperature = /^(o\d|gpt-5)/i.test(modelId);
    const reqBody = {
        model: modelId,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 4096,
        messages: [
            { role: 'system', content: CASE_ANALYSIS_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
    };
    if (!rejectsTemperature) reqBody.temperature = 0.3;

    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`OpenAI HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
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
    logger.success('Phase 7', `[openai:${modelId}] analyzeCase done in ${elapsed}ms · in=${usage?.prompt_tokens} out=${usage?.completion_tokens}`);
    return {
        text: fullText,
        usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
        model: modelId,
        elapsedMs: elapsed,
    };
}

// Multi-turn streaming chat for the "Ask AI Expert" feature. Takes the full
// message history (array of {role, content}) + a system prompt and streams the
// assistant reply. content may be a string or an array of parts (text/image)
// for multimodal turns.
async function expertChat({ messages, systemPrompt, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    const rejectsTemperature = /^(o\d|gpt-5)/i.test(modelId);
    const reqBody = {
        model: modelId,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 4096,
        messages: [
            { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
            ...messages,
        ],
    };
    if (!rejectsTemperature) reqBody.temperature = 0.4;

    const startedAt = Date.now();
    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`OpenAI HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
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

// OpenAI chat-completions has no server-hosted web search, so we use the
// shared DuckDuckGo + page-scrape fallback in webSearch.js. The synthesis is
// done via this adapter's chat() helper so the user's chosen GPT model is
// what writes the answer.
async function synthesizeWithWeb({ query, apiKey, onChunk, model }) {
    const { webResearch } = require('./webSearch');
    return webResearch({ adapter: module.exports, query, apiKey, model: model || DEFAULT_MODEL, onChunk });
}

// Lightweight non-streaming chat helper for the agent's intent classifier.
// Skips streaming + usage tracking — keeps classification calls cheap.
async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const modelId = model || DEFAULT_MODEL;
    // Always use `max_completion_tokens` — canonical for all current
    // OpenAI chat models, future-proof, avoids the "unsupported
    // parameter" 400 when newer model variants drop `max_tokens`.
    const rejectsTemperature = /^(o\d|gpt-5)/i.test(modelId);
    const reqBody = {
        model: modelId,
        max_completion_tokens: maxTokens,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    };
    if (!rejectsTemperature) reqBody.temperature = 0.1;

    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`OpenAI chat HTTP ${resp.status}: ${errBody.substring(0, 200)}`);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
}

// Embeddings for the Ask AI Expert knowledge index. text-embedding-3-small at
// 512 dims keeps the local vector store small while preserving good recall.
const EMBED_URL = 'https://api.openai.com/v1/embeddings';
async function embed(input, { apiKey, model = 'text-embedding-3-small', dimensions = 512 } = {}) {
    const arr = Array.isArray(input) ? input : [input];
    const resp = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: arr, dimensions }),
    });
    if (!resp.ok) {
        const b = await resp.text();
        throw new Error(`OpenAI embeddings HTTP ${resp.status}: ${b.slice(0, 200)}`);
    }
    const data = await resp.json();
    return {
        vectors: (data.data || []).map((d) => d.embedding),
        usage: { total_tokens: data.usage ? data.usage.total_tokens : 0 },
    };
}

module.exports = { META, testKey, synthesize, synthesizeWithWeb, chat, analyzeCase, expertChat, embed, API_URL, sseLines };
