require('dotenv').config();
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

// Box's web search at /folder/0/search uses %20 for spaces (standard URL
// encoding). Match that exactly so the URL looks the same as one shared
// from Box's own UI.
function buildSearchUrl(baseUrl, query) {
    return `${baseUrl}/folder/0/search?query=${encodeURIComponent(query)}`;
}

function buildPortalShortcut(baseUrl, query) {
    return {
        id: `box-portal-${query}`,
        source: 'Box',
        type: 'Open in Box',
        title: `🔗 Search "${query}" in Box`,
        snippet: 'Open this query in Box file search using your existing browser login. Returns files, folders, and content matches from your Ellucian Box workspace.',
        link: buildSearchUrl(baseUrl, query),
        date: null,
        score: 1,
        extras: {
            'Workspace': baseUrl,
            'Search URL': buildSearchUrl(baseUrl, query),
        },
    };
}

async function searchBox(query) {
    const tokens = tokenStore.get('box');
    if (!tokens) {
        throw new Error('Box not authenticated');
    }
    const baseUrl = tokens.baseUrl || process.env.BOX_BASE_URL || 'https://ellucian.app.box.com';
    logger.info('Phase 3', `Box shortcut for "${query}"`);
    return [buildPortalShortcut(baseUrl, query)];
}

module.exports = { searchBox, buildSearchUrl };
