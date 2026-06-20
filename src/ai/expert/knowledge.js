require('dotenv').config();
const Store = require('electron-store');
const { Document } = require('flexsearch');
const logger = require('../../utils/logger');

// Persistent hybrid knowledge index for "Ask AI Expert": survives restarts and
// connector drops. Keyword recall via flexsearch + semantic recall via stored
// embeddings (cosine). Docs are chunked search results / crawled pages.
const store = new Store({
    name: 'perfectsearch-knowledge',
    encryptionKey: process.env.ENCRYPTION_KEY || 'fallback-key-set-env',
    clearInvalidConfig: true,
});
const MAX_DOCS = Number(process.env.EXPERT_KNOWLEDGE_MAX || 6000);

let docs = null;      // in-memory array
let kwIndex = null;   // flexsearch Document

function freshIndex() {
    return new Document({ document: { id: 'id', index: ['title', 'text'], store: ['source', 'title', 'link'] } });
}

function load() {
    if (docs) return;
    docs = store.get('docs') || [];
    kwIndex = freshIndex();
    for (const d of docs) kwIndex.add({ id: d.id, title: d.title || '', text: d.text || '' });
}

function persist() {
    store.set('docs', docs);
    store.set('meta', { builtAt: new Date().toISOString(), count: docs.length });
}

function cosine(a, b) {
    if (!a || !b) return 0;
    let dot = 0; let na = 0; let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function keyOf(d) {
    return String(d.link || d.id || `${d.source}|${d.title}`).toLowerCase();
}

// ── Feedback boosts ─────────────────────────────────────────────────────────
// 👍/👎 on an answer nudges the rank of the sources it cited, so the index
// learns which references are actually useful over time.
function getBoosts() {
    return store.get('boosts') || {};
}
function getBoost(key) {
    const b = getBoosts();
    return Number(b[String(key).toLowerCase()] || 0);
}
function bumpBoost(links, delta) {
    const b = getBoosts();
    for (const link of (links || [])) {
        const k = String(link || '').toLowerCase();
        if (!k) continue;
        b[k] = Math.max(-5, Math.min(5, (Number(b[k]) || 0) + delta));
    }
    store.set('boosts', b);
}

function addDocuments(newDocs) {
    load();
    const existing = new Set(docs.map(keyOf));
    let added = 0;
    for (const d of (newDocs || [])) {
        const k = keyOf(d);
        if (!k || existing.has(k)) continue;
        existing.add(k);
        const id = d.id || `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const doc = {
            id,
            source: d.source || '',
            title: d.title || '',
            link: d.link || '',
            text: String(d.text || '').slice(0, 4000),
            embedding: Array.isArray(d.embedding) ? d.embedding : null,
            // Static rank boost — learned resolutions get a base boost so they
            // surface ahead of raw search snippets on similar future issues.
            boost: Number(d.boost || 0),
        };
        docs.push(doc);
        kwIndex.add({ id, title: doc.title, text: doc.text });
        added += 1;
    }
    // Simple FIFO cap.
    while (docs.length > MAX_DOCS) {
        const dropped = docs.shift();
        if (dropped) try { kwIndex.remove(dropped.id); } catch (_) { /* ignore */ }
    }
    persist();
    return added;
}

function clear() {
    docs = [];
    kwIndex = freshIndex();
    persist();
}

function stats() {
    load();
    const bySource = {};
    let withEmbeddings = 0;
    for (const d of docs) {
        bySource[d.source || 'unknown'] = (bySource[d.source || 'unknown'] || 0) + 1;
        if (d.embedding) withEmbeddings += 1;
    }
    return { count: docs.length, withEmbeddings, bySource, builtAt: (store.get('meta') || {}).builtAt || null };
}

function keywordSearch(query, k = 8) {
    load();
    try {
        const res = kwIndex.search(query, { limit: k });
        const ids = new Set();
        for (const field of (res || [])) {
            for (const item of (field.result || [])) ids.add(typeof item === 'object' ? item.id : item);
        }
        return [...ids].map((id) => docs.find((d) => d.id === id)).filter(Boolean).slice(0, k);
    } catch (_) { return []; }
}

function semanticSearch(qEmb, k = 8) {
    load();
    if (!qEmb) return [];
    const scored = docs.filter((d) => d.embedding).map((d) => ({ d, s: cosine(qEmb, d.embedding) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map((x) => x.d);
}

// Hybrid scored recall: gather keyword + semantic candidates, then rank by
// semantic similarity + keyword match + learned boost + feedback boost.
function recall(query, qEmb, k = 8) {
    load();
    const kwHits = keywordSearch(query, k * 2);
    const kwKeys = new Set(kwHits.map(keyOf));
    const semHits = semanticSearch(qEmb, k * 2);

    const candidates = new Map();
    for (const d of [...kwHits, ...semHits]) candidates.set(keyOf(d), d);

    const scored = [...candidates.values()].map((d) => {
        const sem = (qEmb && d.embedding) ? cosine(qEmb, d.embedding) : 0;
        const kw = kwKeys.has(keyOf(d)) ? 1 : 0;
        const boost = (Number(d.boost) || 0) + getBoost(keyOf(d));
        const score = sem * 1.0 + kw * 0.5 + boost * 0.25;
        return { d, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((x) => x.d);
}

module.exports = { addDocuments, clear, stats, recall, keywordSearch, semanticSearch, cosine, getBoost, bumpBoost };
