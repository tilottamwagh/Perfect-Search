require('dotenv').config();
const { SYSTEM_PROMPT, selectSources, buildUserMessage } = require('./prompt');
const logger = require('../utils/logger');

// `gpt-4o-mini` is OpenAI's cheap workhorse. ~$0.15/M input, $0.60/M output.
// Override via env if you want gpt-4o or another variant.
const DEFAULT_MODEL = process.env.OMNISEARCH_OPENAI_MODEL || 'gpt-4o-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';

const META = {
    id: 'openai',
    name: 'OpenAI',
    color: 'emerald',
    keyPrefix: 'sk-',
    keyHelp: 'Get a key at platform.openai.com/api-keys. Requires billing setup; gpt-4o-mini is very cheap (~$0.003/query).',
    pricing: 'paid · ~$0.003/query on gpt-4o-mini',
    defaultModel: DEFAULT_MODEL,
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

async function synthesize({ query, results, apiKey, onChunk }) {
    const picked = selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');

    const userText = buildUserMessage(query, picked);
    logger.info('Phase 6', `[openai] sources=${picked.length} prompt=${userText.length} chars`);
    const startedAt = Date.now();

    const resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: DEFAULT_MODEL,
            max_tokens: 4096,
            temperature: 0.4,
            stream: true,
            stream_options: { include_usage: true },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userText },
            ],
        }),
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
    logger.success('Phase 6', `[openai] done in ${elapsed}ms · in=${usage?.prompt_tokens} out=${usage?.completion_tokens}`);

    return {
        text: fullText,
        picked,
        usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
        model: DEFAULT_MODEL,
        elapsedMs: elapsed,
    };
}

module.exports = { META, testKey, synthesize };
