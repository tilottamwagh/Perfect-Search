require('dotenv').config();
const { searchSlack } = require('../connectors/slack');
const { searchConfluence } = require('../connectors/confluence');
const { searchServiceNow } = require('../connectors/servicenow');
const { searchAtlassian } = require('../connectors/atlassian');
const { searchBox } = require('../connectors/box');
const { searchJira } = require('../connectors/jira');
const { searchResources } = require('../connectors/resources');
const { searchWebsite } = require('../connectors/website');
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

const cache = new Map();
const CACHE_TTL = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;

function getCacheKey(query) {
    return query.toLowerCase().trim();
}

function getFromCache(query) {
    const cached = cache.get(getCacheKey(query));
    if (cached && Date.now() - cached.time < CACHE_TTL) {
        logger.info('Phase 4', `Cache hit for "${query}"`);
        return cached.results;
    }
    return null;
}

function setCache(query, results) {
    cache.set(getCacheKey(query), { results, time: Date.now() });
    if (cache.size > 50) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

function scoreResult(result, query) {
    const terms = query.toLowerCase().split(/\s+/);
    const title = (result.title || '').toLowerCase();
    const snippet = (result.snippet || '').toLowerCase();
    let score = result.score || 0;

    terms.forEach((term) => {
        if (title.includes(term)) {
            score += 3;
        }
        if (snippet.includes(term)) {
            score += 1;
        }
    });

    if (result.date) {
        const ageDays = (Date.now() - new Date(result.date).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays < 7) {
            score += 2;
        } else if (ageDays < 30) {
            score += 1;
        }
    }

    return { ...result, score };
}

// Normalize a URL into a stable dedup key so the same logical resource gets
// collapsed even when surfaced with cosmetic differences: case in the host,
// trailing slashes, hash fragments, irrelevant query params (utm_*, fbclid).
// Falls back to a lowercased trimmed string if URL parsing fails.
function normalizeUrlKey(url) {
    if (!url || typeof url !== 'string') return '';
    try {
        const u = new URL(url);
        const params = new URLSearchParams();
        for (const [k, v] of u.searchParams) {
            if (/^utm_|^fbclid$|^gclid$|^_ga$/i.test(k)) continue;
            params.append(k, v);
        }
        const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
        const query = sorted.length ? '?' + sorted.map(([k, v]) => `${k}=${v}`).join('&') : '';
        const path = u.pathname.replace(/\/+$/, '') || '/';
        return `${u.protocol}//${u.host.toLowerCase()}${path}${query}`;
    } catch (_) {
        return url.trim().toLowerCase().replace(/\/+$/, '').split('#')[0];
    }
}

function deduplicate(results) {
    const seen = new Set();
    return results.filter((result) => {
        if (!result.link) return false;
        const key = normalizeUrlKey(result.link);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function search(query, options = {}) {
    if (!query || query.trim().length < 2) {
        return { results: [], sources: {}, errors: {}, total: 0, timeTaken: 0, query: query || '' };
    }

    const trimmed = query.trim();
    const cached = getFromCache(trimmed);
    if (cached && options.slack === false) {
        return cached;
    }

    const status = tokenStore.getStatus();
    const sourcesToSearch = {
        slack: options.slack !== false && status.slack,
        confluence: options.confluence !== false && status.confluence,
        servicenow: options.servicenow !== false && status.servicenow,
        atlassian: options.atlassian !== false && status.atlassian,
        box: options.box !== false && status.box,
        jira: options.jira !== false && status.jira,
        resources: options.resources !== false && status.resources,
        website: options.website !== false,
    };

    logger.info('Phase 4', `Unified search for "${trimmed}"`);
    const startedAt = Date.now();

    const [slackRes, confRes, snowRes, atlRes, boxRes, jiraRes, resRes, webRes] = await Promise.allSettled([
        sourcesToSearch.slack ? searchSlack(trimmed) : Promise.resolve([]),
        sourcesToSearch.confluence ? searchConfluence(trimmed) : Promise.resolve([]),
        sourcesToSearch.servicenow ? searchServiceNow(trimmed) : Promise.resolve([]),
        sourcesToSearch.atlassian ? searchAtlassian(trimmed) : Promise.resolve([]),
        sourcesToSearch.box ? searchBox(trimmed) : Promise.resolve([]),
        sourcesToSearch.jira ? searchJira(trimmed) : Promise.resolve([]),
        sourcesToSearch.resources ? searchResources(trimmed) : Promise.resolve([]),
        sourcesToSearch.website ? searchWebsite(trimmed) : Promise.resolve([]),
    ]);

    const combined = [
        ...(slackRes.status === 'fulfilled' ? slackRes.value : []),
        ...(confRes.status === 'fulfilled' ? confRes.value : []),
        ...(snowRes.status === 'fulfilled' ? snowRes.value : []),
        ...(atlRes.status === 'fulfilled' ? atlRes.value : []),
        ...(boxRes.status === 'fulfilled' ? boxRes.value : []),
        ...(jiraRes.status === 'fulfilled' ? jiraRes.value : []),
        ...(resRes.status === 'fulfilled' ? resRes.value : []),
        ...(webRes.status === 'fulfilled' ? webRes.value : []),
    ];

    const response = {
        results: deduplicate(combined.map((result) => scoreResult(result, trimmed))).sort((a, b) => b.score - a.score),
        sources: {
            slack: slackRes.status === 'fulfilled' ? slackRes.value.length : 0,
            confluence: confRes.status === 'fulfilled' ? confRes.value.length : 0,
            servicenow: snowRes.status === 'fulfilled' ? snowRes.value.length : 0,
            atlassian: atlRes.status === 'fulfilled' ? atlRes.value.length : 0,
            box: boxRes.status === 'fulfilled' ? boxRes.value.length : 0,
            jira: jiraRes.status === 'fulfilled' ? jiraRes.value.length : 0,
            resources: resRes.status === 'fulfilled' ? resRes.value.length : 0,
            website: webRes.status === 'fulfilled' ? webRes.value.length : 0,
        },
        errors: {
            slack: slackRes.status === 'rejected' ? slackRes.reason?.message : null,
            confluence: confRes.status === 'rejected' ? confRes.reason?.message : null,
            servicenow: snowRes.status === 'rejected' ? snowRes.reason?.message : null,
            atlassian: atlRes.status === 'rejected' ? atlRes.reason?.message : null,
            box: boxRes.status === 'rejected' ? boxRes.reason?.message : null,
            jira: jiraRes.status === 'rejected' ? jiraRes.reason?.message : null,
            resources: resRes.status === 'rejected' ? resRes.reason?.message : null,
            website: webRes.status === 'rejected' ? webRes.reason?.message : null,
        },
        total: 0,
        timeTaken: Date.now() - startedAt,
        query: trimmed,
    };

    response.total = response.results.length;

    const hasAuthError = Object.values(response.errors).some((error) => error === 'AUTH_EXPIRED');
    const allowCaching = options.slack === false;

    if (!hasAuthError && allowCaching) {
        setCache(trimmed, response);
    }

    logger.success('Phase 4', `Unified search completed in ${response.timeTaken}ms`);
    return response;
}

function clearCache() {
    cache.clear();
    logger.info('Phase 4', 'Search cache cleared');
}

module.exports = { search, clearCache };
