require('dotenv').config();
const { SYSTEM_PROMPT, selectSources, buildUserMessage } = require('./prompt');
const logger = require('../utils/logger');

// `gemini-2.0-flash` is generally-available and on Google's free tier
// (~15 RPM / 1,500 requests per day at the time of writing). Override via env.
const DEFAULT_MODEL = process.env.OMNISEARCH_GEMINI_MODEL || 'gemini-2.0-flash';
const API_HOST = 'https://generativelanguage.googleapis.com';

const MODELS = [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash — fast & free, recommended', tier: 'standard', supportsWeb: true },
    { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (experimental)', tier: 'experimental', supportsWeb: true },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro — highest quality, slower', tier: 'premium', supportsWeb: true },
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash — proven workhorse', tier: 'standard', supportsWeb: true },
    { id: 'gemini-1.5-flash-8b', label: 'Gemini 1.5 Flash-8B — smallest, cheapest', tier: 'fast', supportsWeb: false },
    { id: 'gemini-exp-1206', label: 'Gemini Experimental 1206', tier: 'experimental', supportsWeb: true },
];

const META = {
    id: 'gemini',
    name: 'Google Gemini',
    color: 'rose',
    keyPrefix: 'AIza',
    keyHelp: 'Get a free key at aistudio.google.com/app/apikey. Generous free tier (1,500 requests/day).',
    pricing: 'free tier · then very cheap',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    supportsWeb: true,
};

function gem(apiKey, modelId, endpoint = 'streamGenerateContent') {
    // alt=sse asks Google to deliver the stream as Server-Sent Events
    // (one JSON chunk per `data:` line) instead of a JSON array — much
    // easier to consume incrementally.
    const sseParam = endpoint === 'streamGenerateContent' ? '&alt=sse' : '';
    return `${API_HOST}/v1beta/models/${modelId}:${endpoint}?key=${encodeURIComponent(apiKey)}${sseParam}`;
}

async function testKey(apiKey) {
    try {
        const resp = await fetch(gem(apiKey, DEFAULT_MODEL, 'generateContent'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'Reply with just the word OK.' }] }],
                generationConfig: { maxOutputTokens: 16 },
            }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            return { ok: false, error: `HTTP ${resp.status}: ${body.substring(0, 200)}` };
        }
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { ok: /ok/i.test(text), model: DEFAULT_MODEL };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

// Parse a Gemini SSE stream. Each event is `data: {json}\n\n`.
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
            const line = block.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try { yield JSON.parse(payload); } catch (_) { /* ignore malformed chunks */ }
        }
    }
}

async function synthesize({ query, results, apiKey, onChunk, model }) {
    const picked = selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;

    const userText = buildUserMessage(query, picked);
    logger.info('Phase 6', `[gemini:${modelId}] sources=${picked.length} prompt=${userText.length} chars`);
    const startedAt = Date.now();

    const body = {
        systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
    };

    const resp = await fetch(gem(apiKey, modelId, 'streamGenerateContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Gemini HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let fullText = '';
    let usage = null;
    for await (const chunk of sseLines(resp)) {
        const parts = chunk?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
            if (typeof p.text === 'string') {
                fullText += p.text;
                if (onChunk) try { onChunk(p.text); } catch (_) {}
            }
        }
        if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    }

    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[gemini:${modelId}] done in ${elapsed}ms · in=${usage?.promptTokenCount} out=${usage?.candidatesTokenCount}`);

    return {
        text: fullText,
        picked,
        usage: usage ? { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount, total_tokens: usage.totalTokenCount } : null,
        model: modelId,
        elapsedMs: elapsed,
    };
}

// Web variant: enables Gemini's built-in Google Search grounding. The model
// runs live searches and returns answers with grounded citations. Free tier
// supports this on the Flash models.
async function synthesizeWithWeb({ query, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    const startedAt = Date.now();
    logger.info('Phase 6', `[gemini:${modelId}:web] researching "${query}"`);

    const WEB_PROMPT = `You are a research assistant. Search the web for information about: "${query}"

Write a concise markdown summary with:
1. A one-sentence TL;DR
2. Key findings as bullet points (4-8 bullets max)
3. A "Sources" section listing the URLs

Stay focused on what's actually in the search results. Do not speculate.`;

    const body = {
        contents: [{ role: 'user', parts: [{ text: WEB_PROMPT }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 3072, temperature: 0.3 },
    };

    const resp = await fetch(gem(apiKey, modelId, 'streamGenerateContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Gemini web HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let fullText = '';
    let usage = null;
    const webSources = [];
    const seenUrls = new Set();

    for await (const chunk of sseLines(resp)) {
        const cand = chunk?.candidates?.[0];
        const parts = cand?.content?.parts || [];
        for (const p of parts) {
            if (typeof p.text === 'string') {
                fullText += p.text;
                if (onChunk) try { onChunk(p.text); } catch (_) {}
            }
        }
        // Gemini exposes grounding metadata with the URLs it searched.
        const grounding = cand?.groundingMetadata;
        if (grounding?.groundingChunks) {
            for (const g of grounding.groundingChunks) {
                const uri = g?.web?.uri;
                const title = g?.web?.title;
                if (uri && !seenUrls.has(uri)) {
                    seenUrls.add(uri);
                    webSources.push({ title: title || uri, url: uri, snippet: null });
                }
            }
        }
        if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    }

    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[gemini:${modelId}:web] done in ${elapsed}ms · sources=${webSources.length}`);

    return {
        text: fullText,
        webSources,
        usage: usage ? { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount } : null,
        model: modelId,
        elapsedMs: elapsed,
    };
}

module.exports = { META, testKey, synthesize, synthesizeWithWeb };
