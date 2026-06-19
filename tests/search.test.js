const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('electron-store', () => {
    const store = {};

    return jest.fn().mockImplementation(() => ({
        set: (key, value) => {
            store[key] = value;
        },
        get: (key) => store[key],
        delete: (key) => {
            delete store[key];
        },
        clear: () => {
            Object.keys(store).forEach((key) => delete store[key]);
        },
    }));
});

jest.mock('../src/connectors/slack', () => ({ searchSlack: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/confluence', () => ({ searchConfluence: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/servicenow', () => ({ searchServiceNow: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/website', () => ({ searchWebsite: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/atlassian', () => ({ searchAtlassian: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/box', () => ({ searchBox: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/jira', () => ({ searchJira: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/resources', () => ({ searchResources: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/datadog', () => ({ searchDatadog: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/connectors/aws', () => ({ searchAws: jest.fn().mockResolvedValue([]) }));

const tokenStore = require('../src/auth/tokenStore');
const { search, clearCache } = require('../src/search/engine');

describe('Search Engine', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearCache();
        tokenStore.clearAll();
        tokenStore.save('slack', { token: 'test' });
    });

    it('returns empty for short queries', async () => {
        const result = await search('a');
        expect(result.results).toEqual([]);
    });

    it('runs search and returns result structure', async () => {
        const result = await search('test query');

        expect(result).toHaveProperty('results');
        expect(result).toHaveProperty('sources');
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('timeTaken');
    });

    it('deduplicates results by link', async () => {
        const { searchSlack } = require('../src/connectors/slack');

        searchSlack.mockResolvedValueOnce([
            { id: '1', source: 'Slack', title: 'Test', snippet: 'hello', link: 'https://slack.com/1', score: 1 },
            { id: '2', source: 'Slack', title: 'Test', snippet: 'hello', link: 'https://slack.com/1', score: 1 },
        ]);

        const result = await search('test dedup');
        expect(result.results.length).toBe(1);
    });

    it('deduplicates cosmetic URL variants (trailing slash, fragment, case, tracking params)', async () => {
        const { searchSlack } = require('../src/connectors/slack');

        searchSlack.mockResolvedValueOnce([
            { id: '1', source: 'Slack', title: 'A', snippet: '', link: 'https://Confluence.example.com/wiki/spaces/X/pages/100', score: 1 },
            { id: '2', source: 'Slack', title: 'A', snippet: '', link: 'https://confluence.example.com/wiki/spaces/X/pages/100/', score: 1 },
            { id: '3', source: 'Slack', title: 'A', snippet: '', link: 'https://confluence.example.com/wiki/spaces/X/pages/100#heading', score: 1 },
            { id: '4', source: 'Slack', title: 'A', snippet: '', link: 'https://confluence.example.com/wiki/spaces/X/pages/100?utm_source=email', score: 1 },
            { id: '5', source: 'Slack', title: 'B', snippet: '', link: 'https://confluence.example.com/wiki/spaces/Y/pages/200', score: 1 },
        ]);

        const result = await search('dedup variants');
        expect(result.results.length).toBe(2);
    });

    it('harvests a connector _notice into the per-source errors map', async () => {
        const { searchConfluence } = require('../src/connectors/confluence');

        searchConfluence.mockResolvedValueOnce([
            {
                id: 'confluence-portal-x',
                source: 'Confluence',
                title: 'Search in Confluence',
                link: 'https://confluence.example.com/wiki/search?text=x',
                score: 1,
                _notice: 'Confluence REST API access denied (HTTP 403) — your Atlassian role lacks REST API permission.',
            },
        ]);
        tokenStore.save('confluence', { cookieHeader: 'c=1', baseUrl: 'https://confluence.example.com' });

        const result = await search('notice query');
        expect(result.errors.confluence).toMatch(/HTTP 403/);
        // The notice must not clobber a source that succeeded cleanly.
        expect(result.errors.slack).toBeFalsy();
    });

    it('caches results on repeated query', async () => {
        const { searchSlack } = require('../src/connectors/slack');

        await search('cached query', { slack: false });
        await search('cached query', { slack: false });
        expect(searchSlack).toHaveBeenCalledTimes(0);
    });
});
