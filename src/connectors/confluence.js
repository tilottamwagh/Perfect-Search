require('dotenv').config();
const axios = require('axios');
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

// Confluence's web search page accepts a `text` query param and uses %20 for
// spaces (not '+'). Matching that exact encoding makes the link visually
// identical to one the user would have shared from the UI.
function buildConfluenceSearchUrl(baseUrl, query) {
    const encoded = encodeURIComponent(query); // %20-encoded spaces
    return `${baseUrl}/wiki/search?text=${encoded}`;
}

function buildPortalShortcut(baseUrl, query) {
    return {
        id: `confluence-portal-${query}`,
        source: 'Confluence',
        type: 'Open in Confluence',
        title: `🔗 Search "${query}" in Confluence`,
        snippet: 'Open this query in the Confluence web search using your existing browser login. Use this if a specific page isn\'t in the results above.',
        link: buildConfluenceSearchUrl(baseUrl, query),
        date: null,
        score: 1,
    };
}

async function searchConfluence(query) {
    const tokens = tokenStore.get('confluence');
    if (!tokens) {
        throw new Error('Confluence not authenticated');
    }

    const maxResults = Number(process.env.MAX_RESULTS_PER_SOURCE || 300);
    const timeout = Number(process.env.SEARCH_TIMEOUT_MS || 15000);
    const baseUrl = tokens.baseUrl || process.env.CONFLUENCE_BASE_URL;
    const portalShortcut = buildPortalShortcut(baseUrl, query);

    try {
        logger.info('Phase 3', `Searching Confluence for "${query}" (max=${maxResults})`);
        // CQL: escape any double-quotes in the query so they don't break the literal.
        const safeQuery = query.replace(/"/g, '\\"');
        const cql = `text ~ "${safeQuery}" AND type IN (page, blogpost) ORDER BY lastmodified DESC`;

        const response = await axios.get(`${baseUrl}/wiki/rest/api/search`, {
            params: {
                cql,
                limit: maxResults,
                expand: 'content.space,content.version',
            },
            headers: {
                Cookie: tokens.cookieHeader,
                'Content-Type': 'application/json',
                'X-Atlassian-Token': 'no-check',
            },
            timeout,
        });

        const apiResults = (response.data.results || []).map((item) => {
            // Confluence Cloud's `_links.webui` is a path relative to /wiki.
            // For the modern API it usually starts with /spaces/...; older
            // responses already include /wiki/. Normalize so we always end up
            // with exactly one /wiki segment regardless of the shape.
            const rawWebui = item.content?._links?.webui || '';
            const link = rawWebui
                ? `${baseUrl}${rawWebui.startsWith('/wiki') ? '' : '/wiki'}${rawWebui}`
                : `${baseUrl}/wiki`;
            const content = item.content || {};
            const space = content.space || {};
            const version = content.version || {};
            return {
                id: `confluence-${content.id}`,
                source: 'Confluence',
                type: content.type === 'blogpost' ? 'Blog Post' : 'Page',
                title: content.title || 'Untitled',
                snippet: (item.excerpt || '').replace(/@@@hl@@@|@@@endhl@@@/g, ''),
                link,
                space: space.name,
                author: version.by?.displayName,
                date: version.when,
                score: item.score || 0,
                extras: {
                    'Content ID': content.id || null,
                    'Space key': space.key || null,
                    'Space ID': space.id || null,
                    'Status': content.status || null,
                    'Version': version.number != null ? `v${version.number}` : null,
                    'Last edited by': version.by?.displayName || null,
                    'Editor email': version.by?.email || null,
                    'API self link': content._links?.self || null,
                    'Editor link': content._links?.editui ? `${baseUrl}${content._links.editui.startsWith('/wiki') ? '' : '/wiki'}${content._links.editui}` : null,
                    'Tiny link': content._links?.tinyui ? `${baseUrl}${content._links.tinyui.startsWith('/wiki') ? '' : '/wiki'}${content._links.tinyui}` : null,
                    'Relevance score': item.score != null ? item.score.toFixed(3) : null,
                },
            };
        });

        // Always append the portal shortcut so the user has a fallback path
        // even when the API returns hits.
        const results = [...apiResults, portalShortcut];
        logger.success('Phase 3', `Confluence returned ${results.length} result(s) (${apiResults.length} API + portal-shortcut)`);
        return results;
    } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            // Auth blocked — same pattern as ServiceNow: don't throw a scary
            // error, just surface the shortcut so the user can still get to
            // Confluence in one click.
            logger.warn('Phase 3', `Confluence REST API blocked (HTTP ${status}) — returning portal shortcut`);
            return [portalShortcut];
        }

        logger.error('Phase 3', 'Confluence search failed (returning portal shortcut)', error);
        return [portalShortcut];
    }
}

module.exports = { searchConfluence, buildConfluenceSearchUrl };
