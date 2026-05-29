require('dotenv').config();
const { SYSTEM_PROMPT, selectSources, buildUserMessage } = require('./prompt');
const logger = require('../utils/logger');

// `gemini-2.0-flash` is generally-available and on Google's free tier
// (~15 RPM / 1,500 requests per day at the time of writing). Override via env.
const DEFAULT_MODEL = process.env.OMNISEARCH_GEMINI_MODEL || 'gemini-2.0-flash';
const API_HOST = 'https://generativelanguage.googleapis.com';

const META = {
    id: 'gemini',
    name: 'Google Gemini',
    color: 'rose',
    keyPrefix: 'AIza',
    keyHelp: 'Get a free key at aistudio.google.com/app/apikey. Generous free tier (1,500 requests/day).',
    pricing: 'free tier · then very cheap',
    defaultModel: DEFAULT_MODEL,
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

async function synthesize({ query, results, apiKey, onChunk }) {
    const picked = selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');

    const userText = buildUserMessage(query, picked);
    logger.info('Phase 6', `[gemini] sources=${picked.length} prompt=${userText.length} chars`);
    const startedAt = Date.now();

    const body = {
        // Gemini's "systemInstruction" is the equivalent of system prompt.
        systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
    };

    const resp = await fetch(gem(apiKey, DEFAULT_MODEL, 'streamGenerateContent'), {
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
    logger.success('Phase 6', `[gemini] done in ${elapsed}ms · in=${usage?.promptTokenCount} out=${usage?.candidatesTokenCount}`);

    return {
        text: fullText,
        picked,
        usage: usage ? { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount, total_tokens: usage.totalTokenCount } : null,
        model: DEFAULT_MODEL,
        elapsedMs: elapsed,
    };
}

module.exports = { META, testKey, synthesize };
