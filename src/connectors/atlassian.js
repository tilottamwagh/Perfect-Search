require('dotenv').config();
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

// Atlassian unified search at home.atlassian.com works via an authenticated
// SPA that calls Atlassian's internal cross-product search graphql endpoint.
// Because that endpoint isn't part of the documented public API and would
// require reverse-engineering, the practical integration here mirrors the
// ServiceNow approach: surface a single "🔗 Open in Atlassian" result that
// deep-links into the home.atlassian.com search UI with the query pre-filled.
// The user's existing browser login at home.atlassian.com renders the real
// results — capped at the 100 the Atlassian UI itself returns.

function buildOrgSearchUrl(orgId, cloudId, query) {
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    return `https://home.atlassian.com/o/${orgId}/search?cloudId=${cloudId}&text=${encoded}`;
}

// Generic fallback used when org/cloud IDs weren't captured during SSO. This
// URL still works — Atlassian redirects it to the user's default org's
// search page using their existing session cookies — but the result UX is
// slightly less targeted.
function buildGenericSearchUrl(query) {
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    return `https://home.atlassian.com/search?text=${encoded}`;
}

async function searchAtlassian(query) {
    const tokens = tokenStore.get('atlassian');
    if (!tokens) {
        throw new Error('Atlassian not authenticated');
    }

    const { orgId, cloudId } = tokens;
    const haveIds = Boolean(orgId && cloudId);

    const url = haveIds
        ? buildOrgSearchUrl(orgId, cloudId, query)
        : buildGenericSearchUrl(query);

    if (!haveIds) {
        // Don't throw AUTH_EXPIRED — the user IS authenticated, we just
        // don't have their org/cloud IDs. The generic search URL still
        // works, just lands on a slightly broader landing page.
        logger.warn('Phase 3', 'Atlassian org/cloud IDs missing — using generic search URL fallback');
    }
    logger.info('Phase 3', `Atlassian shortcut for "${query}" → ${url}`);

    return [{
        id: `atlassian-portal-${query}`,
        source: 'Atlassian',
        type: haveIds ? 'Open in Atlassian' : 'Open in Atlassian (generic)',
        title: haveIds
            ? `🔗 Search "${query}" in Atlassian Portal (Confluence + Jira + more)`
            : `🔗 Search "${query}" in Atlassian (generic — org not auto-detected)`,
        snippet: haveIds
            ? 'Opens the Atlassian unified search using your existing browser session. Returns up to 100 matches across Confluence pages, Jira issues, and other Atlassian products in your org.'
            : 'Opens Atlassian search using your session cookies. To get org-targeted results, disconnect and reconnect Atlassian — after the SSO window opens, click into your specific org so the URL contains `/o/<orgId>/?cloudId=<id>` before closing.',
        link: url,
        date: null,
        score: 1,
    }];
}

// `buildSearchUrl` kept as an alias for backward compatibility with tests.
module.exports = { searchAtlassian, buildSearchUrl: buildOrgSearchUrl, buildOrgSearchUrl, buildGenericSearchUrl };
