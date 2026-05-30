require('dotenv').config();
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

// AWS connectors point at two distinct hosts:
//   - The org's IAM Identity Center start page: https://d-XXXXXXXX.awsapps.com/start/#/
//   - The console (regional): https://<region>.console.aws.amazon.com/...
// We store the SSO start URL in tokens.baseUrl; the console host is derived
// from the user-selected region (default us-east-1).
const DEFAULT_REGION = 'us-east-1';

function getRegion(tokens) {
    return (tokens && tokens.region) || process.env.AWS_REGION || DEFAULT_REGION;
}

function getSsoStartUrl(tokens) {
    return (tokens && tokens.baseUrl) || process.env.AWS_SSO_START_URL || '';
}

function consoleHost(region) {
    return `https://${region}.console.aws.amazon.com`;
}

// CloudWatch Logs Insights uses a hash-routed editor. Pre-filling the query
// string requires AWS's bespoke "y-syntax" URL encoding which is brittle to
// generate from JS — instead we just open the Logs Insights editor and let
// the user paste their query there. The URL still focuses the right view.
function buildLogsInsightsUrl(region) {
    return `${consoleHost(region)}/cloudwatch/home?region=${region}#logsV2:logs-insights`;
}

function buildConsoleSearchUrl(region, query) {
    // AWS's global search box on the console home page accepts URL params.
    const q = encodeURIComponent(query);
    return `${consoleHost(region)}/console/home?region=${region}&searchQuery=${q}#`;
}

function buildCloudWatchLogGroupsUrl(region, query) {
    // Log groups list also supports prefix filtering via the hash route.
    const q = encodeURIComponent(query);
    return `${consoleHost(region)}/cloudwatch/home?region=${region}#logsV2:log-groups$3FlogGroupNameFilter$3D${q}`;
}

function shortcut({ id, title, snippet, link, region, ssoStartUrl, type }) {
    return {
        id,
        source: 'AWS',
        type,
        title,
        snippet,
        link,
        date: null,
        score: 1,
        extras: {
            Region: region,
            'SSO start URL': ssoStartUrl || '(not set)',
            'Search URL': link,
        },
    };
}

async function searchAws(query) {
    const tokens = tokenStore.get('aws');
    if (!tokens) {
        throw new Error('AWS not authenticated');
    }
    const region = getRegion(tokens);
    const ssoStartUrl = getSsoStartUrl(tokens);
    logger.info('Phase 3', `AWS shortcuts for "${query}" (region=${region})`);

    return [
        shortcut({
            id: `aws-console-${query}`,
            type: 'Console search',
            title: `🔍 Search AWS Console for "${query}"`,
            snippet: 'Open the AWS Console with the unified search box pre-populated. Resolves services, resources, blogs, and documentation matching this term.',
            link: buildConsoleSearchUrl(region, query),
            region,
            ssoStartUrl,
        }),
        shortcut({
            id: `aws-cwl-groups-${query}`,
            type: 'CloudWatch Log Groups',
            title: `📂 Find CloudWatch log groups matching "${query}"`,
            snippet: 'Filter CloudWatch log groups whose name contains this term — quick way to jump to a specific service or Lambda function\'s logs.',
            link: buildCloudWatchLogGroupsUrl(region, query),
            region,
            ssoStartUrl,
        }),
        shortcut({
            id: `aws-cwl-insights-${query}`,
            type: 'Logs Insights',
            title: `📈 Open CloudWatch Logs Insights`,
            snippet: 'Jump into the CloudWatch Logs Insights editor to run a query across one or more log groups. AWS\'s URL hash format makes pre-filling the query unreliable — paste your search inside the editor.',
            link: buildLogsInsightsUrl(region),
            region,
            ssoStartUrl,
        }),
    ];
}

module.exports = {
    searchAws,
    buildLogsInsightsUrl,
    buildConsoleSearchUrl,
    buildCloudWatchLogGroupsUrl,
};
