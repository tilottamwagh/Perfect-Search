require('dotenv').config();
const embeddings = require('../embeddings');
const tokenStore = require('../../auth/tokenStore');
const knowledge = require('./knowledge');
const logger = require('../../utils/logger');

// Seed terms drive the initial sweep: we can't enumerate every Slack message
// via the cookie API, so we sample the corpus across ALL connected sources with
// broad domain terms, then the index also grows incrementally from live use
// (cacheResults). Override with EXPERT_INDEX_SEEDS.
const DEFAULT_SEEDS = (process.env.EXPERT_INDEX_SEEDS
    || 'EMA,BEP,Ethos,Data Connect,DataConnect,SFRSTCR,SFASTCA,GUID,publish rule,Banner,Experience,Flywire,integration error,timeout,authentication,401,queue,RabbitMQ,API failure,Ethos events,real time events,section registration,GUREDIA,GUABEPR,ILP,Change Notification,webhook,SSO,provisioning'
).split(',').map((s) => s.trim()).filter(Boolean);

function toDoc(r) {
    return {
        source: r.source || '',
        title: r.title || '',
        link: r.link || '',
        text: `${r.title || ''}\n${(r.snippet || '').replace(/\s+/g, ' ')}`.slice(0, 2000),
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Embed one batch with retry/backoff on rate limits (429) and transient errors.
async function embedBatch(batch, _apiKey, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const result = await embeddings.embed(batch);
            return { vectors: result.vectors, tokens: (result.usage && result.usage.total_tokens) || 0, meta: result.meta, model: result.model, provider: result.provider };
        } catch (e) {
            const msg = String(e.message || '');
            // Quota/billing exhaustion is NOT retryable — fail fast so the build
            // doesn't hang in backoff. Flag it so the caller can stop entirely.
            if (/insufficient_quota|exceeded your current quota|check your plan and billing|quota|billing|payment instrument|credits/i.test(msg)) {
                const qe = new Error('INSUFFICIENT_QUOTA: Embedding provider is out of credits/quota.');
                qe.quota = true;
                throw qe;
            }
            const retryable = /HTTP 429|HTTP 5\d\d|timeout|ECONN|ETIMEDOUT|socket hang up/i.test(msg);
            if (attempt < retries && retryable) {
                const wait = /429/.test(msg) ? 3000 * Math.pow(2, attempt) : 1500 * (attempt + 1);
                logger.warn('Phase 0', `embed batch retry ${attempt + 1}/${retries} after ${wait}ms (${msg.slice(0, 80)})`);
                await sleep(wait);
                continue;
            }
            throw e;
        }
    }
    throw new Error('embed batch exhausted retries');
}

// Embed texts resiliently. Returns vectors aligned to input (null where a batch
// ultimately failed, so the rest still get embedded — never all-or-nothing).
async function embedDocs(texts, { onProgress } = {}) {
    const provider = embeddings.preferredProvider();
    if (!provider || !texts.length) return { vectors: null, tokens: 0, provider: null };
    const out = new Array(texts.length).fill(null);
    let tokens = 0;
    let embedMeta = null;
    let embedModel = null;
    let embedProvider = provider;
    let quotaExhausted = false;
    const BATCH = 64;
    for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        try {
            const r = await embedBatch(batch, null);
            for (let j = 0; j < (r.vectors || []).length; j += 1) out[i + j] = r.vectors[j];
            tokens += r.tokens;
            embedMeta = embedMeta || r.meta || null;
            embedModel = embedModel || r.model || null;
            embedProvider = embedProvider || r.provider || null;
        } catch (e) {
            if (e.quota) {
                logger.warn('Phase 0', 'Embedding stopped: Embedding provider is out of quota/credits. Keyword index is intact; add credits and run Build again to embed.');
                quotaExhausted = true;
                break;
            }
            logger.warn('Phase 0', `embed batch @${i} failed permanently (kept keyword-only): ${e.message}`);
        }
        if (onProgress) onProgress({ phase: 'embed', done: Math.min(i + BATCH, texts.length), total: texts.length });
        await sleep(120); // gentle pacing to avoid rate limits
    }
    return { vectors: out, tokens, quotaExhausted, meta: embedMeta, model: embedModel, provider: embedProvider };
}

// Full(ish) build: sweep seed terms across all connected sources, dedupe, embed,
// and store. onProgress({ phase, ... }) drives a UI progress bar.
async function buildIndex({ seeds, onProgress } = {}) {
    const { search } = require('../../search/engine');
    const terms = (Array.isArray(seeds) && seeds.length) ? seeds : DEFAULT_SEEDS;
    const collected = new Map();

    for (let i = 0; i < terms.length; i += 1) {
        const t = terms[i];
        if (onProgress) onProgress({ phase: 'search', term: t, i: i + 1, total: terms.length, collected: collected.size });
        try {
            const sr = await search(t, { website: false });
            for (const r of (sr.results || [])) {
                if (/Open in /i.test(r.type || '')) continue;
                const key = String(r.link || r.id || r.title || '').toLowerCase();
                if (!key || collected.has(key)) continue;
                collected.set(key, toDoc(r));
            }
        } catch (e) {
            logger.warn('Phase 0', `seed "${t}" failed: ${e.message}`);
        }
    }

    // Full crawls of the authoritative sources (in addition to the seed sweep):
    // all Confluence pages, all ServiceNow KB articles, and the Ellucian docs
    // site(s). Each is best-effort — failures don't abort the build.
    const addDocs = (docs) => {
        for (const d of (docs || [])) {
            const key = String(d.link || d.title || '').toLowerCase();
            if (!key || collected.has(key)) continue;
            collected.set(key, { source: d.source, title: d.title, link: d.link, text: d.text });
        }
    };
    const crawl = require('./crawl');
    try { if (onProgress) onProgress({ phase: 'confluence', count: 0 }); addDocs(await crawl.crawlConfluence({ onProgress })); } catch (e) { logger.warn('Phase 0', `Confluence crawl failed: ${e.message}`); }
    try { if (onProgress) onProgress({ phase: 'servicenow-kb', count: 0 }); addDocs(await crawl.crawlServiceNowKB({ onProgress })); } catch (e) { logger.warn('Phase 0', `ServiceNow KB crawl failed: ${e.message}`); }
    const docSites = (process.env.EXPERT_DOC_SITES || 'https://resources.elluciancloud.com').split(',').map((s) => s.trim()).filter(Boolean);
    for (const site of docSites) {
        try {
            // If the site is behind login, reuse the matching connector's saved
            // session cookies so the crawl gets the real pages. The Resources
            // connector covers *.elluciancloud.com.
            if (onProgress) onProgress({ phase: 'web', host: site, count: 0 });
            let docs = []; let login = 0;
            if (/elluciancloud\.com/i.test(site)) {
                // Ellucian Resources is an authenticated JS/SPA site — render it
                // in a window on the Resources connector's session.
                const rendered = await crawl.crawlWebsiteRendered(site, { partition: 'persist:perfectsearch-resources', onProgress });
                docs = rendered.docs; login = rendered.login;
            } else {
                const res = await crawl.crawlWebsite(site, { onProgress });
                docs = res.docs; login = res.login;
            }
            addDocs(docs);
            if (!docs.length) {
                logger.warn('Phase 0', `${site}: 0 readable pages (${login} login/gated). If Ellucian Resources, make sure the Resources source is connected in Settings.`);
            } else {
                logger.info('Phase 0', `${site}: crawled ${docs.length} pages`);
            }
        } catch (e) { logger.warn('Phase 0', `Web crawl ${site} failed: ${e.message}`); }
    }

    // Store everything keyword-first (cheap, never fails), then embed in a
    // resilient, RESUMABLE backfill — so a rate-limit (429) can't wipe the whole
    // build, and re-running Build keeps filling in embeddings until done.
    const items = [...collected.values()];
    const added = knowledge.addDocuments(items);

    let embedded = 0;
    let quotaExhausted = false;
    try {
        const missing = knowledge.unembedded(Number(process.env.EXPERT_EMBED_PER_BUILD || 4000));
        if (missing.length) {
            if (onProgress) onProgress({ phase: 'embed', total: missing.length });
            const r = await embedDocs(missing.map((d) => d.text), { onProgress });
            quotaExhausted = !!r.quotaExhausted;
            if (r.tokens) { try { require('../usage').record({ feature: 'index-embed', model: r.model || 'embedding', inTok: r.tokens, outTok: 0 }); } catch (_) { /* ignore */ } }
            if (r.vectors) {
                const pairs = missing.map((d, i) => (r.vectors[i] ? { id: d.id, embedding: r.vectors[i], embeddingMeta: r.meta || { provider: r.provider, model: r.model, dimensions: r.vectors[i].length } } : null)).filter(Boolean);
                embedded = knowledge.applyEmbeddings(pairs);
            }
        }
    } catch (e) {
        logger.warn('Phase 0', `embedding backfill failed: ${e.message}`);
    }

    const s = knowledge.stats();
    if (onProgress) onProgress({ phase: 'done', added, embedded, quotaExhausted, ...s });
    const remaining = s.count - s.withEmbeddings;
    logger.success('Phase 0', `Knowledge index built: swept ${terms.length} terms, +${added} new docs (total ${s.count}, embedded ${s.withEmbeddings}${remaining > 0 ? `, ${remaining} still keyword-only — run Build again to embed more` : ''})`);
    return { added, embedded, swept: terms.length, ...s };
}

// Save a resolved-case learning into the knowledge index: problem + resolution,
// embedded and boosted so it surfaces ahead of raw snippets on similar issues.
// This is the durable "it learns from what we solve" mechanism.
async function saveLearning({ title, problem, content, note }) {
    const text = [
        problem ? `PROBLEM: ${problem}` : '',
        content ? `RESOLUTION / ANALYSIS:\n${content}` : '',
        note ? `NOTE FROM ENGINEER: ${note}` : '',
    ].filter(Boolean).join('\n\n').slice(0, 4000);
    if (!text.trim()) return { added: 0, error: 'nothing to save' };

    let embedding = null;
    let embeddingMeta = null;
    try {
        const e = await embedDocs([text]);
        if (e.vectors) [embedding] = e.vectors;
        embeddingMeta = e.meta || (embedding ? { provider: e.provider, model: e.model, dimensions: embedding.length } : null);
        if (e.tokens) { try { require('../usage').record({ feature: 'index-embed', model: e.model || 'embedding', inTok: e.tokens, outTok: 0 }); } catch (_) { /* ignore */ } }
    } catch (_) { /* keyword-only */ }

    const doc = {
        source: 'Learned',
        title: (title || problem || 'Resolution').slice(0, 120),
        link: `learned://${Date.now().toString(36)}`,
        text,
        embedding,
        embeddingMeta,
        boost: 2,
    };
    const added = knowledge.addDocuments([doc]);
    logger.success('Phase 8', `Saved learning: "${doc.title}" (embedded=${embedding ? 'yes' : 'no'})`);
    return { added, ...knowledge.stats() };
}

// Incremental: fold live search results into the index (keyword-only; they get
// embeddings on the next full build). Lets the index learn from real usage.
function cacheResults(results) {
    try {
        const items = (results || [])
            .filter((r) => r && r.title && !/Open in /i.test(r.type || ''))
            .map(toDoc);
        if (items.length) knowledge.addDocuments(items);
    } catch (_) { /* best-effort */ }
}

module.exports = { buildIndex, cacheResults, saveLearning, DEFAULT_SEEDS };
