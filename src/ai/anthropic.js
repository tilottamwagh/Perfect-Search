require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, selectSources, buildUserMessage } = require('./prompt');
const logger = require('../utils/logger');

const DEFAULT_MODEL = process.env.OMNISEARCH_ANTHROPIC_MODEL || 'claude-opus-4-7';

// Curated list of currently-available Anthropic models. Updated June 2026.
const MODELS = [
    // Current 4.7 family
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 — flagship, top reasoning', tier: 'premium', supportsWeb: true },
    { id: 'claude-sonnet-4-7', label: 'Claude Sonnet 4.7 — best price/performance', tier: 'standard', supportsWeb: true },
    { id: 'claude-haiku-4-7', label: 'Claude Haiku 4.7 — fastest, cheapest current-gen', tier: 'fast', supportsWeb: true },
    // 4.6 family — still widely used
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 — previous flagship', tier: 'premium', supportsWeb: true },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — proven workhorse', tier: 'standard', supportsWeb: true },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — stable cheap option', tier: 'fast', supportsWeb: true },
    // 4.5 legacy
    { id: 'claude-opus-4-5', label: 'Claude Opus 4.5 — legacy', tier: 'legacy', supportsWeb: true },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 — legacy', tier: 'legacy', supportsWeb: true },
    // 3.x legacy (long context, cheap)
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet — legacy, very cheap', tier: 'legacy', supportsWeb: false },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku — legacy, cheapest', tier: 'legacy', supportsWeb: false },
];

const META = {
    id: 'anthropic',
    name: 'Anthropic Claude',
    color: 'amber',
    keyPrefix: 'sk-ant-',
    keyHelp: 'Get a key at console.anthropic.com → API Keys. Requires credit balance (not included with Claude Pro).',
    pricing: 'paid · ~$0.02–0.05/query on Opus, ~$0.005 on Haiku',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    supportsWeb: true,
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

async function synthesize({ query, results, apiKey, onChunk, model }) {
    const client = new Anthropic({ apiKey });
    const modelId = model || DEFAULT_MODEL;
    const picked = selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');

    const userText = buildUserMessage(query, picked);
    logger.info('Phase 6', `[anthropic:${modelId}] sources=${picked.length} prompt=${userText.length} chars`);
    let fullText = '';
    const startedAt = Date.now();

    // Opus 4.7 uses adaptive thinking. Other models accept the same param but
    // ignore unsupported variants — keep the call shape consistent.
    const stream = await client.messages.stream({
        model: modelId,
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
    logger.success('Phase 6', `[anthropic:${modelId}] done in ${elapsed}ms · in=${usage?.input_tokens} out=${usage?.output_tokens} cache_read=${usage?.cache_read_input_tokens || 0}`);

    return { text: fullText, picked, usage, model: modelId, elapsedMs: elapsed };
}

// Web-research variant: uses Anthropic's server-hosted `web_search` tool to
// pull live results from the internet, then asks Claude to synthesize them
// alongside the user's question. Returns the answer plus any URLs Claude
// cited from its search.
async function synthesizeWithWeb({ query, apiKey, onChunk, model }) {
    const client = new Anthropic({ apiKey });
    const modelId = model || DEFAULT_MODEL;
    const startedAt = Date.now();
    logger.info('Phase 6', `[anthropic:${modelId}:web] researching "${query}"`);

    const WEB_PROMPT = `You are a research assistant. The user is searching their enterprise tools for a question. In parallel, you should look on the public internet for related context (blog posts, vendor docs, community discussions, news, GitHub issues, Stack Overflow, etc.).

Use the web_search tool to find relevant external information about: "${query}"

Then write a concise markdown summary with:
1. A one-sentence TL;DR
2. Key findings as bullet points
3. A "Sources" section listing the URLs you cited

Keep it focused — 4-8 bullets max. Do NOT speculate beyond what the search results say.`;

    let fullText = '';
    let webSources = [];

    const stream = await client.messages.stream({
        model: modelId,
        max_tokens: 3072,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
        messages: [{ role: 'user', content: WEB_PROMPT }],
    });

    stream.on('text', (delta) => {
        fullText += delta;
        if (onChunk) try { onChunk(delta); } catch (_) {}
    });

    const finalMessage = await stream.finalMessage();

    // Walk the response for web_search tool results so we can surface the
    // discovered URLs as clickable cards in the UI.
    for (const block of finalMessage.content || []) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
            for (const item of block.content) {
                if (item.type === 'web_search_result') {
                    webSources.push({
                        title: item.title || item.url,
                        url: item.url,
                        snippet: item.encrypted_content ? null : (item.text || null),
                    });
                }
            }
        }
    }

    const usage = finalMessage.usage;
    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[anthropic:${modelId}:web] done in ${elapsed}ms · sources=${webSources.length} in=${usage?.input_tokens} out=${usage?.output_tokens}`);

    return { text: fullText, webSources, usage, model: modelId, elapsedMs: elapsed };
}

module.exports = { META, testKey, synthesize, synthesizeWithWeb };
