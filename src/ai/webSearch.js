// Shared web-search fallback for providers that don't bundle their own
// server-hosted search tool (OpenAI chat-completions, DeepSeek, Bedrock,
// Agent Router). Strategy:
//
//   1. Query DuckDuckGo's HTML endpoint and parse the top organic results.
//   2. Fetch the top N pages in parallel, strip HTML to plain text.
//   3. Build a prompt with the snippets + page extracts.
//   4. Hand the prompt to the caller's adapter.chat() helper for synthesis.
//
// This means every provider gets a "Web Research" mode without needing a
// proprietary search tool. The quality is rougher than Anthropic/Gemini's
// native grounded search, but it works on any chat model.
const { parse } = require('node-html-parser');
const logger = require('../utils/logger');

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Fetch DuckDuckGo HTML and parse out the top organic results.
async function ddgSearch(query, { limit = 5 } = {}) {
    const params = new URLSearchParams({ q: query, kl: 'us-en' });
    const resp = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });
    if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
    const html = await resp.text();
    const root = parse(html);
    const results = [];
    for (const el of root.querySelectorAll('div.result, div.web-result')) {
        const titleEl = el.querySelector('a.result__a');
        const snippetEl = el.querySelector('a.result__snippet, .result__snippet');
        if (!titleEl) continue;
        let url = titleEl.getAttribute('href') || '';
        // DuckDuckGo wraps URLs in /l/?uddg=…
        try {
            const m = url.match(/uddg=([^&]+)/);
            if (m) url = decodeURIComponent(m[1]);
        } catch (_) { /* keep raw */ }
        const title = (titleEl.text || '').trim();
        const snippet = ((snippetEl && snippetEl.text) || '').trim();
        if (title && url && /^https?:\/\//.test(url)) {
            results.push({ title, url, snippet });
            if (results.length >= limit) break;
        }
    }
    return results;
}

// Fetch a single page, strip to plain text, cap length.
async function fetchPageText(url, { maxChars = 3000, timeoutMs = 8000 } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html' },
            signal: controller.signal,
        });
        if (!resp.ok) return null;
        const ct = resp.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml/i.test(ct)) return null;
        const html = await resp.text();
        const root = parse(html);
        // Drop noise.
        for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']) {
            for (const el of root.querySelectorAll(tag)) el.remove();
        }
        const text = (root.querySelector('main, article, .content, #content, body')?.text || root.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxChars);
        return text || null;
    } catch (_) {
        return null;
    } finally {
        clearTimeout(t);
    }
}

// Run a full web research round. Adapter must expose chat(sys, usr, opts)
// returning a string.
//
//   adapter   — the AI adapter (must have .chat)
//   query     — user's question
//   apiKey    — caller's API key
//   model     — model id
//   onChunk   — optional progress callback (we stream the synth call below)
//
// Streaming is achieved by calling chat() and then re-emitting the result via
// onChunk in one shot — DDG fetches aren't streamable, but the UI still gets
// the answer. If you want true token streaming, the adapter's synthesize()
// could be used instead.
async function webResearch({ adapter, query, apiKey, model, onChunk, maxResults = 5, maxPages = 3 }) {
    const startedAt = Date.now();
    logger.info('Phase 6', `[webSearch] researching "${query}"`);

    let results = [];
    try {
        results = await ddgSearch(query, { limit: maxResults });
    } catch (err) {
        throw new Error(`Web search failed: ${err.message}`);
    }
    if (results.length === 0) {
        throw new Error('Web search returned no results. Try a different phrasing or use Anthropic/Gemini for higher-quality web research.');
    }

    // Fetch top N pages in parallel for richer context.
    const pages = await Promise.all(
        results.slice(0, maxPages).map(async (r) => ({ ...r, fullText: await fetchPageText(r.url) })),
    );

    const sourcesBlock = results.map((r, i) => {
        const page = pages.find((p) => p.url === r.url);
        const body = page?.fullText || r.snippet || '';
        return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${body}\n`;
    }).join('\n---\n');

    const SYSTEM = 'You are a research assistant. Summarize the supplied web search results to answer the user\'s question. Format: one-sentence TL;DR, 4-8 bullet key findings, then a Sources section listing the URLs you cited as [N] markers.';
    const USER = `User question: "${query}"\n\nWeb search results:\n\n${sourcesBlock}\n\nWrite the markdown answer now. Cite sources as [N] inline.`;

    if (typeof adapter.chat !== 'function') {
        throw new Error('Adapter does not expose a chat() helper required for web research fallback.');
    }
    const text = await adapter.chat(SYSTEM, USER, { apiKey, model, maxTokens: 2048 });

    // Surface the answer in one chunk so the UI still gets a stream event.
    if (onChunk && typeof text === 'string' && text.length > 0) {
        try { onChunk(text); } catch (_) {}
    }

    const webSources = results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet || null }));
    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[webSearch] done in ${elapsed}ms · sources=${webSources.length}`);
    return { text: text || '', webSources, model, elapsedMs: elapsed };
}

module.exports = { webResearch, ddgSearch, fetchPageText };
