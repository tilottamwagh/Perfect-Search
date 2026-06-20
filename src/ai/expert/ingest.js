require('dotenv').config();
const openai = require('../openai');
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

async function embedDocs(texts) {
    const apiKey = tokenStore.getAiKey('openai');
    if (!apiKey || !texts.length) return null;
    const out = [];
    const BATCH = 96;
    for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const embs = await openai.embed(batch, { apiKey });
        out.push(...embs);
    }
    return out;
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

    const items = [...collected.values()];
    if (onProgress) onProgress({ phase: 'embed', total: items.length });
    let embeddings = null;
    try { embeddings = await embedDocs(items.map((d) => d.text)); } catch (e) {
        logger.warn('Phase 0', `embedding failed (keyword-only): ${e.message}`);
    }
    if (embeddings) items.forEach((d, idx) => { d.embedding = embeddings[idx]; });

    const added = knowledge.addDocuments(items);
    const s = knowledge.stats();
    if (onProgress) onProgress({ phase: 'done', added, ...s });
    logger.success('Phase 0', `Knowledge index built: swept ${terms.length} terms, +${added} new docs (total ${s.count}, embedded ${s.withEmbeddings})`);
    return { added, swept: terms.length, ...s };
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
    try { const e = await embedDocs([text]); if (e) [embedding] = e; } catch (_) { /* keyword-only */ }

    const doc = {
        source: 'Learned',
        title: (title || problem || 'Resolution').slice(0, 120),
        link: `learned://${Date.now().toString(36)}`,
        text,
        embedding,
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
