require('dotenv').config();
const axios = require('axios');
const { parse } = require('node-html-parser');
const { API_URL, sseLines } = require('../openai');
const tokenStore = require('../../auth/tokenStore');
const logger = require('../../utils/logger');

// ───────────────────────────────────────────────────────────────────────────
// Ask AI Expert — agentic tool-use loop (Phase B)
//
// The model reasons, then calls tools to gather evidence from your connectors
// and docs, reads the results, and repeats until it can answer — exactly the
// loop in the design diagram. Tools run app-side; the final answer is streamed.
// ───────────────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = Number(process.env.EXPERT_MAX_TOOL_ITERATIONS || 6);

// Tool schemas advertised to the model (OpenAI function-calling format).
const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'recall_knowledge',
            description: 'Search the pre-built knowledge index (institutional knowledge gathered from Slack/Confluence/ServiceNow KB/Jira, persisted locally). Use this FIRST on every issue — it works even when live connectors are disconnected and returns past discussions, runbooks, and resolutions with a citation number [n]. If it returns nothing useful, fall back to search_sources for live data.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to recall — error phrase, product + feature, symptom, or identifier.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_sources',
            description: 'Search the connected enterprise sources for information relevant to the issue: Slack threads, Confluence pages/runbooks, ServiceNow cases & KB articles, Jira, Datadog, AWS. Use precise queries (exact error phrases, product + feature, identifiers). Returns ranked results with a citation number [n], title, source, snippet and link.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query — an exact error phrase, product + feature, or identifier works best.' },
                    sources: {
                        type: 'array',
                        description: 'Optional subset of sources to search. Omit to search the fast text sources (Slack, Confluence) plus ServiceNow KB.',
                        items: { type: 'string', enum: ['slack', 'confluence', 'servicenow', 'jira', 'datadog', 'aws'] },
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'fetch_doc',
            description: 'Fetch a PUBLIC documentation/web page by URL (e.g. resources.elluciancloud.com) and return its readable text. Do NOT use for authenticated Slack/ServiceNow/Atlassian/Jira links — those need a login and will only return a sign-in page; use the search_sources snippet for those instead.',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string', description: 'The full https URL to fetch.' } },
                required: ['url'],
            },
        },
    },
];

// ── Tool executors ──────────────────────────────────────────────────────────

// Map a friendly source list to the search engine's per-source option flags.
function sourceOptions(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
        // Default: fast text sources + ServiceNow KB; skip website/box/atlassian/resources noise.
        return { website: false, box: false, atlassian: false, resources: false, datadog: false, aws: false };
    }
    const all = ['slack', 'confluence', 'servicenow', 'jira', 'datadog', 'aws', 'atlassian', 'box', 'resources', 'website'];
    const opts = {};
    for (const s of all) opts[s] = sources.includes(s);
    return opts;
}

async function execSearchSources(args, ctx) {
    const { search } = require('../../search/engine');
    const query = String(args.query || '').trim();
    if (!query) return { error: 'empty query' };
    const opts = sourceOptions(args.sources);

    // Report connection status so the model never mistakes "not connected" for
    // "no data exists". A search only hits a source whose session is valid.
    const status = tokenStore.getStatus();
    const requested = (Array.isArray(args.sources) && args.sources.length) ? args.sources : ['slack', 'confluence', 'servicenow'];
    const connectable = ['slack', 'confluence', 'servicenow', 'jira', 'datadog', 'aws'];
    const notConnected = requested.filter((s) => connectable.includes(s) && status[s] === false);
    const searched = requested.filter((s) => !notConnected.includes(s));

    let results = [];
    try {
        const sr = await search(query, opts);
        const real = (sr.results || []).filter((r) => !/Open in /i.test(r.type || ''));
        // Incremental learning: fold live results into the knowledge index so
        // they're recallable later even when connectors are disconnected.
        try { require('./ingest').cacheResults(real); } catch (_) { /* best-effort */ }
        results = real.slice(0, 8);
    } catch (e) {
        return { error: `search failed: ${e.message}`, notConnected };
    }
    if (results.length === 0 && notConnected.length > 0) {
        return {
            query,
            searched,
            notConnected,
            count: 0,
            results: [],
            note: `No results — these sources are NOT connected, so they could not be searched: ${notConnected.join(', ')}. Tell the user to connect them in Settings (this is NOT evidence the data doesn't exist).`,
        };
    }
    // Register each result in the shared citation map so the model can cite [n]
    // and the UI can resolve the number back to the source link.
    const out = results.map((r) => {
        const key = (r.link || r.id || r.title || '').toLowerCase();
        let n = ctx.sourceIndex.get(key);
        if (!n) {
            n = ctx.sources.length + 1;
            ctx.sourceIndex.set(key, n);
            ctx.sources.push({ n, title: r.title || '(untitled)', source: r.source || '', type: r.type || '', link: r.link || '' });
        }
        return {
            n,
            source: r.source,
            type: r.type,
            title: r.title,
            snippet: (r.snippet || '').replace(/\s+/g, ' ').slice(0, 280),
            link: r.link,
        };
    });
    return { query, searched, notConnected, count: out.length, results: out };
}

async function execFetchDoc(args, ctx) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { error: 'invalid url' };
    // fetch_doc is an unauthenticated HTTP GET — it can't log in, so fetching
    // Slack/ServiceNow/Atlassian/Jira links just returns a sign-in page. Skip
    // them and tell the model to use the search_sources snippet instead.
    if (/(slack\.com|service-now\.com|atlassian\.net|atlassian\.com)/i.test(url)) {
        return { skipped: true, note: 'That is an authenticated Slack/ServiceNow/Atlassian URL — fetch_doc cannot sign in. Rely on the search_sources snippet for this source, or ask the user to paste the content.' };
    }
    try {
        const resp = await axios.get(url, { timeout: 12000, maxContentLength: 5 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0 PerfectSearch' } });
        const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        let text = html;
        try {
            const root = parse(html);
            root.querySelectorAll('script,style,nav,footer,svg').forEach((el) => el.remove());
            text = root.text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
        } catch (_) { /* fall back to raw */ }
        const n = ctx.sources.length + 1;
        ctx.sources.push({ n, title: url, source: 'Doc', type: 'Web page', link: url });
        return { n, url, text: text.slice(0, 6000) };
    } catch (e) {
        return { error: `fetch failed (HTTP ${e.response?.status || '?'}): ${e.message}` };
    }
}

async function execRecallKnowledge(args, ctx) {
    const knowledge = require('./knowledge');
    const query = String(args.query || '').trim();
    if (!query) return { error: 'empty query' };
    let qEmb = null;
    try {
        const key = tokenStore.getAiKey('openai');
        if (key) {
            const e = await require('../openai').embed([query], { apiKey: key });
            qEmb = e.vectors[0];
            if (ctx.usages && e.usage && e.usage.total_tokens) ctx.usages.push({ model: 'text-embedding-3-small', inTok: e.usage.total_tokens, outTok: 0 });
        }
    } catch (_) { /* keyword-only fallback */ }
    const hits = knowledge.recall(query, qEmb, 8);
    if (!hits.length) {
        return { count: 0, note: 'Knowledge index is empty or had no match. Build/refresh it from the Ask AI Expert panel, or use search_sources for live data.' };
    }
    const out = hits.map((d) => {
        const key = String(d.link || d.id || d.title || '').toLowerCase();
        let n = ctx.sourceIndex.get(key);
        if (!n) {
            n = ctx.sources.length + 1;
            ctx.sourceIndex.set(key, n);
            ctx.sources.push({ n, title: d.title || '(untitled)', source: d.source || '', type: 'Knowledge', link: d.link || '' });
        }
        return { n, source: d.source, title: d.title, snippet: (d.text || '').replace(/\s+/g, ' ').slice(0, 280), link: d.link };
    });
    return { query, count: out.length, results: out };
}

async function executeTool(name, args, ctx) {
    if (name === 'recall_knowledge') return execRecallKnowledge(args, ctx);
    if (name === 'search_sources') return execSearchSources(args, ctx);
    if (name === 'fetch_doc') return execFetchDoc(args, ctx);
    return { error: `unknown tool: ${name}` };
}

// Per-provider endpoint + request-shape config. The Expert loop works on any
// OpenAI-compatible chat-completions API that also supports function calling:
// OpenAI itself, DeepSeek (api.deepseek.com), and Agent Router. We resolve the
// URL + token-param style from the active provider rather than hardcoding it.
function providerConfig(providerId, model) {
    if (providerId === 'deepseek') {
        const base = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
        return { url: `${base}/chat/completions`, useMaxCompletion: false, label: 'DeepSeek', defaultModel: 'deepseek-v4-pro' };
    }
    if (providerId === 'agentrouter') {
        const base = process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org/v1';
        return { url: `${base}/chat/completions`, useMaxCompletion: false, label: 'Agent Router', defaultModel: 'claude-opus-4-6' };
    }
    // openai (default)
    return { url: API_URL, useMaxCompletion: true, label: 'OpenAI', defaultModel: 'gpt-5-mini' };
}

// One streaming step: accumulates content + any tool_calls from the SSE stream.
async function streamStep({ apiKey, model, messages, tools, onChunk, cfg }) {
    const c = cfg || providerConfig('openai', model);
    const rejectsTemperature = /^(o\d|gpt-5)/i.test(model);
    const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages,
    };
    // OpenAI uses max_completion_tokens; DeepSeek / others use max_tokens.
    if (c.useMaxCompletion) body.max_completion_tokens = 4096;
    else body.max_tokens = 4096;
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
    if (!rejectsTemperature) body.temperature = 0.3;

    const resp = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${c.label} HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let content = '';
    const toolCalls = [];
    let finish = null;
    let usage = null;
    for await (const chunk of sseLines(resp)) {
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) { content += delta.content; if (onChunk) try { onChunk(delta.content); } catch (_) {} }
        if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const i = tc.index || 0;
                if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (tc.id) toolCalls[i].id = tc.id;
                if (tc.function?.name) toolCalls[i].function.name = tc.function.name;
                if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
            }
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk?.usage) usage = chunk.usage;
    }
    return { content, toolCalls: toolCalls.filter(Boolean), finish, usage };
}

// Run the full agent loop. Streams the final answer via onChunk; reports tool
// activity via onEvent; returns { text, sources, provider, model }.
async function runExpertAgent({ messages, systemPrompt, onChunk, onEvent, currentImages }) {
    const providerId = tokenStore.getActiveAiProvider() && tokenStore.hasAiKey(tokenStore.getActiveAiProvider())
        ? tokenStore.getActiveAiProvider()
        : (tokenStore.hasAiKey('openai') ? 'openai' : (tokenStore.hasAiKey('agentrouter') ? 'agentrouter' : null));
    if (!providerId) throw new Error('AI_NOT_CONFIGURED');
    // The Expert loop needs a provider with OpenAI-style function calling.
    // OpenAI, DeepSeek, and Agent Router qualify. Anthropic/Gemini use a
    // different tool-call wire format and aren't supported here yet.
    const TOOL_CAPABLE = ['openai', 'deepseek', 'agentrouter'];
    if (!TOOL_CAPABLE.includes(providerId)) {
        throw new Error(`Ask AI Expert (with tools) needs a function-calling provider — OpenAI, DeepSeek, or Agent Router. Your active provider is ${providerId}. Switch to one of those in Settings (DeepSeek is cheap and works well here).`);
    }
    const apiKey = tokenStore.getAiKey(providerId);
    const cfg = providerConfig(providerId);
    const model = tokenStore.getAiModel(providerId) || cfg.defaultModel;

    const convo = [{ role: 'system', content: systemPrompt }, ...messages];

    // Attach any uploaded screenshots to the latest user turn so the model can
    // read them (vision). Only on this turn — we don't re-send images each turn.
    if (Array.isArray(currentImages) && currentImages.length) {
        for (let i = convo.length - 1; i >= 0; i -= 1) {
            if (convo[i].role === 'user') {
                const t = typeof convo[i].content === 'string' ? convo[i].content : '';
                convo[i] = {
                    role: 'user',
                    content: [
                        { type: 'text', text: t },
                        ...currentImages.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/png'};base64,${im.base64}` } })),
                    ],
                };
                break;
            }
        }
    }

    const ctx = { sources: [], sourceIndex: new Map(), usages: [] };
    const recordStep = (step) => {
        if (step.usage) ctx.usages.push({ model, inTok: step.usage.prompt_tokens || 0, outTok: step.usage.completion_tokens || 0 });
    };

    for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
        const step = await streamStep({ apiKey, model, messages: convo, tools: TOOL_SCHEMAS, onChunk, cfg });
        recordStep(step);
        if (step.toolCalls.length === 0) {
            logger.success('Phase 8', `Expert agent answered after ${iter} tool round(s); sources=${ctx.sources.length}`);
            return { text: step.content, sources: ctx.sources, usages: ctx.usages, provider: providerId, model };
        }
        convo.push({ role: 'assistant', content: step.content || null, tool_calls: step.toolCalls });
        for (const tc of step.toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* keep {} */ }
            logger.info('Phase 8', `Expert tool: ${tc.function.name}(${JSON.stringify(args).slice(0, 120)})`);
            if (onEvent) try { onEvent({ type: 'tool', name: tc.function.name, args }); } catch (_) {}
            const result = await executeTool(tc.function.name, args, ctx);
            convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
        }
    }

    // Safety net: force a final answer without more tools.
    if (onEvent) try { onEvent({ type: 'status', text: 'wrapping up' }); } catch (_) {}
    const finalConvo = [...convo, { role: 'user', content: 'You have gathered enough. Give your best analysis and next steps now, citing sources with [n].' }];
    const final = await streamStep({ apiKey, model, messages: finalConvo, tools: null, onChunk, cfg });
    recordStep(final);
    return { text: final.content, sources: ctx.sources, usages: ctx.usages, provider: providerId, model };
}

module.exports = { runExpertAgent, TOOL_SCHEMAS, sourceOptions };
