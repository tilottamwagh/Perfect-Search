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

function buildSearchUrl(orgId, cloudId, query) {
    // home.atlassian.com encodes spaces as '+' in the text= param.
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    return `https://home.atlassian.com/o/${orgId}/search?cloudId=${cloudId}&text=${encoded}`;
}

async function searchAtlassian(query) {
    const tokens = tokenStore.get('atlassian');
    if (!tokens) {
        throw new Error('Atlassian not authenticated');
    }

    const { orgId, cloudId } = tokens;
    if (!orgId || !cloudId) {
        logger.warn('Phase 3', 'Atlassian org/cloud IDs missing — re-login needed');
        throw new Error('AUTH_EXPIRED');
    }

    const url = buildSearchUrl(orgId, cloudId, query);
    logger.info('Phase 3', `Atlassian shortcut for "${query}" → ${url}`);

    return [{
        id: `atlassian-portal-${query}`,
        source: 'Atlassian',
        type: 'Open in Atlassian',
        title: `🔗 Search "${query}" in Atlassian Portal (Confluence + Jira + more)`,
        snippet: 'Opens the Atlassian unified search using your existing browser session. Returns up to 100 matches across Confluence pages, Jira issues, and other Atlassian products in your org.',
        link: url,
        date: null,
        score: 1,
    }];
}

module.exports = { searchAtlassian, buildSearchUrl };
