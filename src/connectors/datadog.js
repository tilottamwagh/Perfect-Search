require('dotenv').config();
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

// Datadog org URLs vary by region: app.datadoghq.com (US1, default),
// app.datadoghq.eu (EU), app.us3.datadoghq.com (US3), etc. The user
// configures their org's host in Settings → Connector instance URLs.
const DEFAULT_BASE = 'https://app.datadoghq.com';

function getBase(tokens) {
    return (tokens && tokens.baseUrl) || process.env.DATADOG_BASE_URL || DEFAULT_BASE;
}

// Datadog uses URL-encoded `query=` for both Log Explorer and Live Tail.
// Spaces become %20 in their canonical URLs, so we do the same.
function buildLogExplorerUrl(base, query) {
    const q = encodeURIComponent(query);
    return `${base}/logs?query=${q}&agg_m=count&agg_m_source=base&agg_t=count&cols=host%2Cservice&fromUser=true&messageDisplay=inline&refresh_mode=sliding&storage=hot&stream_sort=desc&viz=stream&live=true`;
}

function buildLiveTailUrl(base, query) {
    const q = encodeURIComponent(query);
    return `${base}/logs/livetail?query=${q}&agg_m=count&agg_m_source=base&agg_t=count&cols=host%2Cservice&fromUser=true&messageDisplay=inline&refresh_mode=sliding&storage=driveline&stream_sort=desc&viz=stream&live=true`;
}

function buildDashboardListUrl(base, query) {
    // The dashboards list page supports a server-side text filter via `q=`.
    const q = encodeURIComponent(query);
    return `${base}/dashboard/lists?q=${q}`;
}

function shortcut({ id, title, snippet, link, base, type }) {
    return {
        id,
        source: 'Datadog',
        type,
        title,
        snippet,
        link,
        date: null,
        score: 1,
        extras: {
            'Datadog org': base,
            'Search URL': link,
        },
    };
}

async function searchDatadog(query) {
    const tokens = tokenStore.get('datadog');
    if (!tokens) {
        throw new Error('Datadog not authenticated');
    }
    const base = getBase(tokens);
    logger.info('Phase 3', `Datadog shortcuts for "${query}"`);

    // Three deep links — opening any of them in a fresh window picks up the
    // user's existing cookie session (captured during SSO login) and lands
    // them inside the correct query view, pre-filtered.
    return [
        shortcut({
            id: `datadog-logs-${query}`,
            type: 'Log Explorer',
            title: `📊 Open Datadog Log Explorer for "${query}"`,
            snippet: 'Search indexed application logs across services and hosts in Datadog Log Explorer with this query pre-applied.',
            link: buildLogExplorerUrl(base, query),
            base,
        }),
        shortcut({
            id: `datadog-livetail-${query}`,
            type: 'Live Tail',
            title: `📡 Open Datadog Live Tail for "${query}"`,
            snippet: 'Stream matching log lines in real time as your services emit them. Useful for debugging issues that are happening right now.',
            link: buildLiveTailUrl(base, query),
            base,
        }),
        shortcut({
            id: `datadog-dashboards-${query}`,
            type: 'Dashboards',
            title: `📋 Find Datadog dashboards matching "${query}"`,
            snippet: 'Browse Datadog dashboards whose names match this term — quick way to jump to the right monitoring view.',
            link: buildDashboardListUrl(base, query),
            base,
        }),
    ];
}

module.exports = { searchDatadog, buildLogExplorerUrl, buildLiveTailUrl, buildDashboardListUrl };
