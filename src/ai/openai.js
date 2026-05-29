require('dotenv').config();
const { SYSTEM_PROMPT, selectSources, buildUserMessage } = require('./prompt');
const logger = require('../utils/logger');

// `gpt-4o-mini` is OpenAI's cheap workhorse. ~$0.15/M input, $0.60/M output.
// Override via env if you want gpt-4o or another variant.
const DEFAULT_MODEL = process.env.OMNISEARCH_OPENAI_MODEL || 'gpt-4o-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';

const MODELS = [
    { id: 'gpt-4o', label: 'GPT-4o — top quality, multimodal', tier: 'premium', supportsWeb: false },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini — very cheap, recommended', tier: 'standard', supportsWeb: false },
    { id: 'gpt-4.1', label: 'GPT-4.1 — latest flagship (if available)', tier: 'premium', supportsWeb: false },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', tier: 'standard', supportsWeb: false },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo — proven legacy', tier: 'legacy', supportsWeb: false },
    { id: 'o1', label: 'o1 — reasoning model, slower & expensive', tier: 'premium', supportsWeb: false },
    { id: 'o1-mini', label: 'o1-mini — smaller reasoning model', tier: 'standard', supportsWeb: false },
    { id: 'o3-mini', label: 'o3-mini — newest small reasoning model', tier: 'standard', supportsWeb: false },
];

const META = {
    id: 'openai',
    name: 'OpenAI',
    color: 'emerald',
    keyPrefix: 'sk-',
    keyHelp: 'Get a key at platform.openai.com/api-keys. Requires billing setup; gpt-4o-mini is very cheap (~$0.003/query).',
    pricing: 'paid · ~$0.003/query on gpt-4o-mini',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    // OpenAI's chat-completions endpoint doesn't bundle web search server-side.
    // The Assistants API offers it but it's a separate flow — out of scope for
    // the BYOK quick path. Web mode for OpenAI users surfaces a friendly note.
    supportsWeb: false,
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
                max_tokens: 16,
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

async function synthesize({ query, results, apiKey, onChunk, model }) {
    const picked = selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;

    const userText = buildUserMessage(query, picked);
    logger.info('Phase 6', `[openai:${modelId}] sources=${picked.length} prompt=${userText.length} chars`);
    const startedAt = Date.now();

    // o-series reasoning models reject `temperature` and use `max_completion_tokens` instead of `max_tokens`.
    const isOSeries = /^o\d/.test(modelId);
    const reqBody = {
        model: modelId,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userText },
        ],
    };
    if (isOSeries) reqBody.max_completion_tokens = 4096;
    else { reqBody.max_tokens = 4096; reqBody.temperature = 0.4; }

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
    logger.success('Phase 6', `[openai:${modelId}] done in ${elapsed}ms · in=${usage?.prompt_tokens} out=${usage?.completion_tokens}`);

    return {
        text: fullText,
        picked,
        usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
        model: modelId,
        elapsedMs: elapsed,
    };
}

// OpenAI chat-completions has no server-hosted web search. Return a clear
// "not supported" so the UI can surface a helpful message rather than failing.
async function synthesizeWithWeb() {
    throw new Error('WEB_NOT_SUPPORTED: OpenAI chat-completions does not include web search. Switch to Anthropic Claude or Google Gemini in Settings to use Web Research.');
}

module.exports = { META, testKey, synthesize, synthesizeWithWeb };
