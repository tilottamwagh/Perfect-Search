require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText } = require('./prompt');
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

async function synthesize({ query, results, apiKey, onChunk, model, systemPrompt, picked: prePicked }) {
    const client = new Anthropic({ apiKey });
    const modelId = model || DEFAULT_MODEL;
    // Phase 2: when ai/index.js has already done selectSources + enrichment,
    // it passes the pre-selected array as `picked`. Otherwise fall back to
    // running selectSources here (backward compat for any direct callers).
    const picked = Array.isArray(prePicked) ? prePicked : selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');

    const userText = buildUserMessage(query, picked);
    // Phase-1 agent integration: caller may pass a dynamically-composed
    // system prompt (intent classification + matching skill). Falls back to
    // the static SYSTEM_PROMPT when the agent layer is bypassed.
    const sysText = (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.length > 0) ? systemPrompt : SYSTEM_PROMPT;
    logger.info('Phase 6', `[anthropic:${modelId}] sources=${picked.length} prompt=${userText.length} chars system=${sysText.length} chars`);
    let fullText = '';
    const startedAt = Date.now();

    // Opus 4.7 uses adaptive thinking. Other models accept the same param but
    // ignore unsupported variants — keep the call shape consistent.
    const stream = await client.messages.stream({
        model: modelId,
        max_tokens: 4096,
        thinking: { type: 'adaptive', display: 'summarized' },
        system: [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }],
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

// Lightweight non-streaming chat helper for the agent's intent classifier.
// Returns the assistant's plain text response (no streaming, no tools, no
// thinking). Used to keep classification calls cheap and predictable.
async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const client = new Anthropic({ apiKey });
    const modelId = model || DEFAULT_MODEL;
    const resp = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [{ role: 'user', content: userPrompt }],
    });
    return (resp.content || []).find((b) => b.type === 'text')?.text || '';
}

// ServiceNow case analysis. Claude supports vision via base64 image blocks,
// so screenshots are sent inline alongside the case text.
async function analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model }) {
    const client = new Anthropic({ apiKey });
    const modelId = model || DEFAULT_MODEL;
    const text = buildCaseAnalysisText(caseBundle, kbResults);
    const images = Array.isArray(caseBundle?.images) ? caseBundle.images : [];

    const userContent = [{ type: 'text', text }];
    for (const img of images) {
        const mime = img.contentType || 'image/png';
        userContent.push({
            type: 'image',
            source: { type: 'base64', media_type: mime, data: img.base64 },
        });
    }

    logger.info('Phase 7', `[anthropic:${modelId}] analyzeCase prompt=${text.length} chars, images=${images.length}, kb=${(kbResults || []).length}`);
    const startedAt = Date.now();

    let fullText = '';
    const stream = await client.messages.stream({
        model: modelId,
        max_tokens: 4096,
        system: [{ type: 'text', text: CASE_ANALYSIS_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: userContent }],
    });
    stream.on('text', (delta) => {
        fullText += delta;
        if (onChunk) try { onChunk(delta); } catch (_) {}
    });

    const finalMessage = await stream.finalMessage();
    const usage = finalMessage.usage;
    const elapsed = Date.now() - startedAt;
    logger.success('Phase 7', `[anthropic:${modelId}] analyzeCase done in ${elapsed}ms · in=${usage?.input_tokens} out=${usage?.output_tokens}`);
    return { text: fullText, usage, model: modelId, elapsedMs: elapsed };
}

// Multi-turn streaming chat for "Ask AI Expert". Accepts an array of
// {role, content} messages where content may be a string or an array of
// content blocks ({type:'text'|'image', ...}).
async function expertChat({ messages, systemPrompt, apiKey, onChunk, model }) {
    const client = new Anthropic({ apiKey });
    const modelId = model || DEFAULT_MODEL;
    const startedAt = Date.now();

    // Anthropic requires alternating user/assistant turns. Translate any
    // OpenAI-shaped image_url parts into Anthropic's image source format so
    // the same UI message history works across providers.
    const normalizedMessages = (messages || []).map((m) => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content };
        const blocks = (m.content || []).map((b) => {
            if (b.type === 'text') return { type: 'text', text: b.text };
            if (b.type === 'image_url' && b.image_url?.url?.startsWith('data:')) {
                const [meta, data] = b.image_url.url.split(',');
                const mime = (meta.match(/data:([^;]+)/) || [null, 'image/png'])[1];
                return { type: 'image', source: { type: 'base64', media_type: mime, data } };
            }
            if (b.type === 'image' && b.source) return b;
            return null;
        }).filter(Boolean);
        return { role: m.role, content: blocks };
    });

    let fullText = '';
    const stream = await client.messages.stream({
        model: modelId,
        max_tokens: 4096,
        system: [{ type: 'text', text: systemPrompt || 'You are a helpful assistant.' }],
        messages: normalizedMessages,
    });
    stream.on('text', (delta) => {
        fullText += delta;
        if (onChunk) try { onChunk(delta); } catch (_) {}
    });

    const finalMessage = await stream.finalMessage();
    const usage = finalMessage.usage;
    return { text: fullText, usage, model: modelId, elapsedMs: Date.now() - startedAt };
}

module.exports = { META, testKey, synthesize, synthesizeWithWeb, chat, analyzeCase, expertChat };
