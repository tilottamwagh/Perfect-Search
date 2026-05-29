require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, selectSources, buildUserMessage } = require('./prompt');
const logger = require('../utils/logger');

const DEFAULT_MODEL = process.env.OMNISEARCH_ANTHROPIC_MODEL || 'claude-opus-4-7';

const META = {
    id: 'anthropic',
    name: 'Anthropic Claude',
    color: 'amber',
    keyPrefix: 'sk-ant-',
    keyHelp: 'Get a key at console.anthropic.com → API Keys. Requires credit balance (not included with Claude Pro).',
    pricing: 'paid · ~$0.02–0.05/query on Opus',
    defaultModel: DEFAULT_MODEL,
};

async function testKey(apiKey) {
    try {
        const c = new Anthropic({ apiKey });
        const resp = await c.messages.create({
            model: DEFAULT_MODEL,
            max_tokens: 16,
            messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
        });
        const text = (resp.content || []).find((b) => b.type === 'text')?.text || '';
        return { ok: /ok/i.test(text), model: DEFAULT_MODEL };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

async function synthesize({ query, results, apiKey, onChunk }) {
    const client = new Anthropic({ apiKey });
    const picked = selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');

    const userText = buildUserMessage(query, picked);
    logger.info('Phase 6', `[anthropic] sources=${picked.length} prompt=${userText.length} chars`);
    let fullText = '';
    const startedAt = Date.now();

    const stream = await client.messages.stream({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive', display: 'summarized' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userText }],
    });

    stream.on('text', (delta) => {
        fullText += delta;
        if (onChunk) try { onChunk(delta); } catch (_) {}
    });

    const finalMessage = await stream.finalMessage();
    const usage = finalMessage.usage;
    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[anthropic] done in ${elapsed}ms · in=${usage?.input_tokens} out=${usage?.output_tokens} cache_read=${usage?.cache_read_input_tokens || 0}`);

    return { text: fullText, picked, usage, model: DEFAULT_MODEL, elapsedMs: elapsed };
}

module.exports = { META, testKey, synthesize };
