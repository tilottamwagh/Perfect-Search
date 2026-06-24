require('dotenv').config();
const Store = require('electron-store');
const logger = require('../utils/logger');

// Central token + cost tracker for every AI call (Expert, Analyze case, Search
// synthesis, embeddings). Cost is computed at record time from an editable
// pricing table, so historical cost stays stable even if prices change.
const store = new Store({
    name: 'perfectsearch-usage',
    encryptionKey: process.env.ENCRYPTION_KEY || 'fallback-key-set-env',
    clearInvalidConfig: true,
});
const MAX_RECORDS = Number(process.env.USAGE_MAX_RECORDS || 50000);

// USD per 1,000,000 tokens. Ballpark defaults — EDIT in Settings to match
// platform.openai.com/pricing for your account/models.
const DEFAULT_PRICING = {
    'gpt-5': { in: 1.25, out: 10 },
    'gpt-5-mini': { in: 0.25, out: 2 },
    'gpt-5-nano': { in: 0.05, out: 0.4 },
    'gpt-4.1': { in: 2, out: 8 },
    'gpt-4.1-mini': { in: 0.4, out: 1.6 },
    'gpt-4.1-nano': { in: 0.1, out: 0.4 },
    'gpt-4o': { in: 2.5, out: 10 },
    'gpt-4o-mini': { in: 0.15, out: 0.6 },
    'o3': { in: 2, out: 8 },
    'o4-mini': { in: 1.1, out: 4.4 },
    'text-embedding-3-small': { in: 0.02, out: 0 },
    'text-embedding-3-large': { in: 0.13, out: 0 },
    default: { in: 1, out: 3 },
};

function getPricing() {
    return { ...DEFAULT_PRICING, ...(store.get('pricing') || {}) };
}
function setPricing(p) {
    store.set('pricing', p || {});
}
function priceFor(model) {
    const p = getPricing();
    if (model && p[model]) return p[model];
    // Longest-prefix match (so "gpt-5-mini-2026" maps to gpt-5-mini before gpt-5).
    let best = null;
    for (const k of Object.keys(p)) {
        if (k !== 'default' && model && model.startsWith(k) && (!best || k.length > best.length)) best = k;
    }
    return best ? p[best] : p.default;
}

function records() {
    return store.get('records') || [];
}

// Record one AI call. Returns the computed cost (USD).
function record({ model, feature, inTok = 0, outTok = 0, threadId } = {}) {
    const pr = priceFor(model);
    const cost = (Number(inTok) / 1e6) * pr.in + (Number(outTok) / 1e6) * pr.out;
    const recs = records();
    recs.push({
        ts: new Date().toISOString(),
        model: model || '?',
        feature: feature || 'other',
        inTok: Number(inTok) || 0,
        outTok: Number(outTok) || 0,
        cost,
        threadId: threadId || null,
    });
    while (recs.length > MAX_RECORDS) recs.shift();
    store.set('records', recs);
    return cost;
}

function emptyAgg() { return { inTok: 0, outTok: 0, tok: 0, cost: 0, count: 0 }; }
function addTo(a, r) { a.inTok += r.inTok; a.outTok += r.outTok; a.tok += r.inTok + r.outTok; a.cost += r.cost; a.count += 1; }

// Daily / weekly / monthly / all-time + by-feature breakdown + a 30-day series.
function summary({ days = 30 } = {}) {
    const recs = records();
    const now = Date.now();
    const dayMs = 86400000;
    const todayKey = new Date().toISOString().slice(0, 10);

    const today = emptyAgg();
    const last7 = emptyAgg();
    const last30 = emptyAgg();
    const all = emptyAgg();
    const byFeature = {};
    const byModel = {};
    const byDay = {};

    for (const r of recs) {
        const t = new Date(r.ts).getTime();
        addTo(all, r);
        if (r.ts.slice(0, 10) === todayKey) addTo(today, r);
        if (t >= now - 7 * dayMs) addTo(last7, r);
        if (t >= now - 30 * dayMs) addTo(last30, r);
        const dkey = r.ts.slice(0, 10);
        if (!byDay[dkey]) byDay[dkey] = emptyAgg();
        addTo(byDay[dkey], r);
        if (!byFeature[r.feature]) byFeature[r.feature] = emptyAgg();
        addTo(byFeature[r.feature], r);
        if (!byModel[r.model]) byModel[r.model] = emptyAgg();
        addTo(byModel[r.model], r);
    }

    const series = [];
    for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(now - i * dayMs).toISOString().slice(0, 10);
        const a = byDay[d] || emptyAgg();
        series.push({ day: d, tok: a.tok, cost: a.cost });
    }

    return { today, last7, last30, all, byFeature, byModel, series, recordCount: recs.length };
}

function perThread(threadId) {
    const agg = emptyAgg();
    for (const r of records()) { if (r.threadId === threadId) addTo(agg, r); }
    return agg;
}

function clear() {
    store.set('records', []);
    logger.info('Phase F', 'Usage records cleared');
}

module.exports = { record, summary, perThread, getPricing, setPricing, clear };
