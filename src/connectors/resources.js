require('dotenv').config();
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

// Ellucian Resources portal search uses `+` for spaces in the query param
// and ships a fixed `content-lang=en-US` selector. Match that exactly so the
// URL the user sees matches what they'd produce typing in the portal itself.
function buildSearchUrl(baseUrl, query) {
    const encoded = encodeURIComponent(query).replace(/%20/g, '+');
    return `${baseUrl}/search?content-lang=en-US&query=${encoded}`;
}

function buildPortalShortcut(baseUrl, query) {
    return {
        id: `resources-portal-${query}`,
        source: 'Resources',
        type: 'Open in Resources',
        title: `🔗 Search "${query}" in Ellucian Resources`,
        snippet: 'Open this query in the Ellucian Resources portal using your existing browser login. Finds documentation, release notes, customer announcements, and product resources across Ellucian Cloud.',
        link: buildSearchUrl(baseUrl, query),
        date: null,
        score: 1,
        extras: {
            'Workspace': baseUrl,
            'Search URL': buildSearchUrl(baseUrl, query),
        },
    };
}

async function searchResources(query) {
    const tokens = tokenStore.get('resources');
    if (!tokens) {
        throw new Error('Resources not authenticated');
    }
    const baseUrl = tokens.baseUrl || process.env.RESOURCES_BASE_URL || 'https://resources.elluciancloud.com';
    logger.info('Phase 3', `Resources shortcut for "${query}"`);
    return [buildPortalShortcut(baseUrl, query)];
}

module.exports = { searchResources, buildSearchUrl };
