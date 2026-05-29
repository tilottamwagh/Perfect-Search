require('dotenv').config();
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

// Jira's "Rovo search" page uses + for spaces in the text= param. Matching
// that exact encoding produces a URL identical to one the user would have
// got by typing the query into Jira's own search box.
function buildSearchUrl(baseUrl, query) {
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    return `${baseUrl}/jira/rovo-search?page=1&sortKey=name&sortOrder=ASC&text=${encoded}`;
}

function buildPortalShortcut(baseUrl, query) {
    return {
        id: `jira-portal-${query}`,
        source: 'Jira',
        type: 'Open in Jira',
        title: `🔗 Search "${query}" in Jira`,
        snippet: 'Open this query in Jira Rovo search using your existing browser login. Finds matching issues, projects, and dashboards.',
        link: buildSearchUrl(baseUrl, query),
        date: null,
        score: 1,
        extras: {
            'Workspace': baseUrl,
            'Search URL': buildSearchUrl(baseUrl, query),
        },
    };
}

async function searchJira(query) {
    const tokens = tokenStore.get('jira');
    if (!tokens) {
        throw new Error('Jira not authenticated');
    }
    const baseUrl = tokens.baseUrl || process.env.JIRA_BASE_URL || 'https://ellucian.atlassian.net';
    logger.info('Phase 3', `Jira shortcut for "${query}"`);
    return [buildPortalShortcut(baseUrl, query)];
}

module.exports = { searchJira, buildSearchUrl };
