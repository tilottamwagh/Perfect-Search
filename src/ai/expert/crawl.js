require('dotenv').config();
const { BrowserWindow } = require('electron');
const axios = require('axios');
const cheerio = require('cheerio');
const tokenStore = require('../../auth/tokenStore');
const session = require('../../auth/session');
const logger = require('../../utils/logger');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Build request headers, including the connector's session cookies when the
// target site needs login (e.g. resources.elluciancloud.com via the Resources
// connector) so the crawl fetches authenticated pages, not sign-in pages.
function reqHeaders(cookieHeader) {
    return cookieHeader ? { 'User-Agent': UA, Cookie: cookieHeader } : { 'User-Agent': UA };
}

function stripHtml(html) {
    try {
        const $ = cheerio.load(html || '');
        $('script,style,nav,footer,header,svg,noscript,form').remove();
        return $('body').text().replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } catch (_) {
        return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

function looksLikeLogin(title, text) {
    return /sign in|log in|login|authenticate|session expired/i.test(`${title} ${text.slice(0, 200)}`);
}

// ── Website crawler (e.g. resources.elluciancloud.com) ──────────────────────
function hostOf(u) { try { return new URL(u).host; } catch (_) { return ''; } }

async function urlsFromSitemap(baseUrl, cookieHeader) {
    const out = [];
    const tryUrls = [`${baseUrl.replace(/\/$/, '')}/sitemap.xml`, `${baseUrl.replace(/\/$/, '')}/sitemap_index.xml`];
    for (const sm of tryUrls) {
        try {
            const r = await axios.get(sm, { timeout: 12000, headers: reqHeaders(cookieHeader) });
            const xml = String(r.data || '');
            const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
            // If it's a sitemap index, recurse one level into child sitemaps.
            for (const loc of locs) {
                if (/\.xml($|\?)/i.test(loc)) {
                    try {
                        const cr = await axios.get(loc, { timeout: 12000, headers: reqHeaders(cookieHeader) });
                        const cx = String(cr.data || '');
                        out.push(...[...cx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]).filter((u) => !/\.xml($|\?)/i.test(u)));
                    } catch (_) { /* skip */ }
                } else {
                    out.push(loc);
                }
            }
            if (out.length) break;
        } catch (_) { /* no sitemap here */ }
    }
    return [...new Set(out)];
}

async function fetchPageDoc(url, cookieHeader) {
    try {
        const r = await axios.get(url, { timeout: 12000, maxContentLength: 5 * 1024 * 1024, headers: reqHeaders(cookieHeader) });
        const ct = String(r.headers['content-type'] || '');
        if (!/text\/html|xml/i.test(ct)) return null;
        const $ = cheerio.load(r.data || '');
        const title = ($('title').first().text() || $('h1').first().text() || url).trim();
        const text = stripHtml(r.data);
        if (!text || text.length < 80) return null;
        return { source: 'Doc', title, link: url, text: `${title}\n${text}`.slice(0, 4000), _login: looksLikeLogin(title, text) };
    } catch (_) { return null; }
}

async function crawlWebsite(baseUrl, { maxPages = 600, maxDepth = 3, onProgress, cookieHeader } = {}) {
    const host = hostOf(baseUrl);
    if (!host) return { docs: [], login: 0 };
    const docs = [];
    let login = 0;
    const visited = new Set();

    // Prefer sitemap enumeration; fall back to BFS link-following.
    let queue = await urlsFromSitemap(baseUrl, cookieHeader);
    const usingSitemap = queue.length > 0;
    if (!usingSitemap) queue = [{ url: baseUrl, depth: 0 }];

    let i = 0;
    while (queue.length && docs.length < maxPages) {
        const item = usingSitemap ? { url: queue[i], depth: 0 } : queue.shift();
        if (usingSitemap) { i += 1; if (i > queue.length) break; }
        const url = item.url;
        if (!url || visited.has(url) || hostOf(url) !== host) { if (usingSitemap && i >= queue.length) break; continue; }
        visited.add(url);

        const doc = await fetchPageDoc(url, cookieHeader);
        if (doc) {
            if (doc._login) login += 1; else { delete doc._login; docs.push(doc); }
            if (!usingSitemap && item.depth < maxDepth && !doc._login) {
                // enqueue same-domain links
                try {
                    const r = await axios.get(url, { timeout: 10000, headers: reqHeaders(cookieHeader) });
                    const $ = cheerio.load(r.data || '');
                    $('a[href]').each((_, a) => {
                        let href = $(a).attr('href');
                        if (!href) return;
                        try { href = new URL(href, url).toString().split('#')[0]; } catch (_) { return; }
                        if (hostOf(href) === host && !visited.has(href)) queue.push({ url: href, depth: item.depth + 1 });
                    });
                } catch (_) { /* skip link extraction */ }
            }
        }
        if (onProgress && docs.length % 10 === 0) onProgress({ phase: 'web', count: docs.length, host });
        if (usingSitemap && i >= queue.length) break;
    }
    logger.info('Phase 0', `Web crawl ${host}: ${docs.length} pages (${login} login/gated pages skipped, sitemap=${usingSitemap})`);
    return { docs, login };
}

// ── Confluence crawler (all pages, paginated REST) ──────────────────────────
async function crawlConfluence({ maxPages = 2000, onProgress } = {}) {
    const t = tokenStore.get('confluence');
    if (!t || !t.cookieHeader) return [];
    const base = t.baseUrl || process.env.CONFLUENCE_BASE_URL;
    const docs = [];
    let start = 0;
    const limit = 50;
    for (let guard = 0; guard < 200 && docs.length < maxPages; guard += 1) {
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
            try {
                res = await axios.get(`${base}/wiki/rest/api/content`, {
                    params: { type: 'page', start, limit, expand: 'body.view,space' },
                    headers: { Cookie: t.cookieHeader, 'X-Atlassian-Token': 'no-check' },
                    timeout: 25000,
                });
            } catch (e) {
                if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
                logger.warn('Phase 0', `Confluence crawl: skipping page batch @${start} (HTTP ${e.response?.status || '?'}: ${e.message})`);
            }
        }
        if (!res) { start += limit; continue; } // skip this batch, keep going
        const results = (res.data && res.data.results) || [];
        if (!results.length) break;
        for (const p of results) {
            const html = (p.body && p.body.view && p.body.view.value) || '';
            const webui = p._links && p._links.webui ? p._links.webui : '';
            docs.push({ source: 'Confluence', title: p.title || 'Untitled', link: `${base}/wiki${webui}`, text: `${p.title}\n${stripHtml(html)}`.slice(0, 4000) });
        }
        start += limit;
        if (onProgress) onProgress({ phase: 'confluence', count: docs.length });
        if (results.length < limit) break;
    }
    logger.info('Phase 0', `Confluence crawl: ${docs.length} pages`);
    return docs;
}

// ── ServiceNow KB crawler (kb_knowledge, via the authenticated window) ───────
async function crawlServiceNowKB({ maxArticles = 2000, onProgress } = {}) {
    const t = tokenStore.get('servicenow');
    if (!t) return [];
    const win = session.getPersistentWindow('servicenow');
    if (!win) { logger.warn('Phase 0', 'ServiceNow KB crawl skipped — no authenticated window (reconnect ServiceNow)'); return []; }
    const { inPageJson } = require('../../connectors/servicenow');
    const base = t.baseUrl || process.env.SERVICENOW_BASE_URL;
    const docs = [];
    let offset = 0;
    const limit = 100;
    for (let guard = 0; guard < 100 && docs.length < maxArticles; guard += 1) {
        const url = `${base}/api/now/table/kb_knowledge?sysparm_query=workflow_state=published^ORDERBYDESCsys_updated_on&sysparm_fields=number,short_description,text,sys_id&sysparm_limit=${limit}&sysparm_offset=${offset}`;
        const res = await inPageJson(win, url, 20000);
        const rows = (res.ok && res.data && res.data.result) || [];
        if (!rows.length) break;
        for (const r of rows) {
            docs.push({ source: 'ServiceNow', title: r.short_description || r.number, link: `${base}/kb_view.do?sys_kb_id=${r.sys_id}`, text: `${r.short_description || ''}\n${stripHtml(r.text || '')}`.slice(0, 4000) });
        }
        offset += limit;
        if (onProgress) onProgress({ phase: 'servicenow-kb', count: docs.length });
        if (rows.length < limit) break;
    }
    logger.info('Phase 0', `ServiceNow KB crawl: ${docs.length} articles`);
    return docs;
}

// In-window rendered crawl for JS/SPA sites (e.g. resources.elluciancloud.com):
// loads each URL in a hidden BrowserWindow on the connector's partition (so it's
// authenticated AND JavaScript runs), waits for render, then extracts the
// rendered text + same-domain links. Heavier than the HTTP crawl, so capped.
async function crawlWebsiteRendered(baseUrl, { partition = 'persist:perfectsearch-resources', maxPages = 250, maxDepth = 4, renderWaitMs = 1500, onProgress } = {}) {
    const host = hostOf(baseUrl);
    if (!host) return { docs: [], login: 0 };
    const win = new BrowserWindow({ show: false, webPreferences: { partition, nodeIntegration: false, contextIsolation: true } });
    const docs = [];
    let login = 0;
    const visited = new Set();
    const queue = [{ url: baseUrl, depth: 0 }];
    try {
        while (queue.length && docs.length < maxPages) {
            const { url, depth } = queue.shift();
            if (!url || visited.has(url) || hostOf(url) !== host) continue;
            visited.add(url);
            try {
                await win.loadURL(url);
                await new Promise((r) => setTimeout(r, renderWaitMs));
                const data = await win.webContents.executeJavaScript(`(function(){
                    try {
                        const title = document.title || location.href;
                        const t = document.body ? document.body.innerText : '';
                        const links = [...document.querySelectorAll('a[href]')].map(a => a.href);
                        const isLogin = /sign in|log in|\\blogin\\b|authenticate/i.test((title + ' ' + t.slice(0,200)));
                        return { title, text: (t || '').slice(0, 9000), links, isLogin, href: location.href };
                    } catch (e) { return { title:'', text:'', links:[], isLogin:false }; }
                })();`, true);
                if (data.isLogin && (!data.text || data.text.length < 120)) { login += 1; }
                else if (data.text && data.text.length >= 80) {
                    docs.push({ source: 'Doc', title: data.title || url, link: data.href || url, text: `${data.title || ''}\n${data.text}`.slice(0, 4000) });
                }
                if (depth < maxDepth) {
                    for (const href of (data.links || [])) {
                        try { const u = new URL(href, url).toString().split('#')[0]; if (hostOf(u) === host && !visited.has(u)) queue.push({ url: u, depth: depth + 1 }); } catch (_) { /* skip */ }
                    }
                }
            } catch (_) { /* skip page */ }
            if (onProgress && docs.length % 5 === 0) onProgress({ phase: 'web', count: docs.length, host });
        }
    } finally {
        if (!win.isDestroyed()) win.close();
    }
    logger.info('Phase 0', `Rendered web crawl ${host}: ${docs.length} pages (${login} login/gated)`);
    return { docs, login };
}

module.exports = { crawlWebsite, crawlWebsiteRendered, crawlConfluence, crawlServiceNowKB, stripHtml };
