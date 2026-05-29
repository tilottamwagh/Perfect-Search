const { describe, it, expect, beforeEach } = require('@jest/globals');
const axios = require('axios');

jest.mock('axios');
const mockExecuteJavaScript = jest.fn();
const mockLoadURL = jest.fn();

jest.mock('electron', () => ({
    BrowserWindow: jest.fn().mockImplementation(() => ({
        loadURL: mockLoadURL,
        isDestroyed: () => false,
        close: jest.fn(),
        webContents: {
            executeJavaScript: mockExecuteJavaScript,
        },
    })),
}));

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

// Mock the session module so getPersistentWindow returns the mock window.
jest.mock('../src/auth/session', () => ({
    getPersistentWindow: jest.fn(() => ({
        isDestroyed: () => false,
        webContents: {
            executeJavaScript: mockExecuteJavaScript,
        },
    })),
    clearPersistentWindow: jest.fn(),
}));

const tokenStore = require('../src/auth/tokenStore');
const { searchSlack } = require('../src/connectors/slack');
const { searchConfluence } = require('../src/connectors/confluence');
const { searchServiceNow } = require('../src/connectors/servicenow');
const { searchAtlassian } = require('../src/connectors/atlassian');
const { searchBox } = require('../src/connectors/box');
const { searchJira } = require('../src/connectors/jira');
const { searchResources } = require('../src/connectors/resources');

const MOCK_TEAM_ID = 'T0TEST123';
const MOCK_CHANNEL_ID = 'C0GENERAL';
const MOCK_TS = '1700000000.000001';

beforeEach(() => {
    tokenStore.clearAll();
    tokenStore.save('slack', {
        xoxcToken: 'xoxc-test',
        allCookies: 'test=1',
        slackTeamId: MOCK_TEAM_ID,
        baseUrl: 'https://test.enterprise.slack.com',
    });
    tokenStore.save('confluence', { cookieHeader: 'session=test', baseUrl: 'https://test.atlassian.net' });
    tokenStore.save('servicenow', { cookieHeader: 'JSESSIONID=test', csrfToken: 'ck123', baseUrl: 'https://test.service-now.com' });
    tokenStore.save('atlassian', {
        orgId: 'org-abc-123',
        cloudId: 'cloud-xyz-456',
        cookieHeader: 'cloud.session.token=test',
        baseUrl: 'https://home.atlassian.com',
    });
    tokenStore.save('box', { baseUrl: 'https://ellucian.app.box.com', landingUrl: 'https://ellucian.app.box.com/folder/0' });
    tokenStore.save('jira', { baseUrl: 'https://ellucian.atlassian.net', sessionToken: 'jt' });
    tokenStore.save('resources', { baseUrl: 'https://resources.elluciancloud.com', landingUrl: 'https://resources.elluciancloud.com/home' });
    jest.clearAllMocks();

    // The new slack connector calls executeJavaScript four times per search:
    //   1. waitForSlackReady  — page state check
    //   2. extractApiToken    — token extraction
    //   3. fetchSlackModule('messages') — search.all messages
    //   4. fetchSlackModule('files')    — search.all files
    mockExecuteJavaScript
        // 1. waitForSlackReady
        .mockResolvedValueOnce({ ready: true, isAuthPage: false, url: `https://app.slack.com/client/${MOCK_TEAM_ID}` })
        // 2. extractApiToken
        .mockResolvedValueOnce({ source: 'boot_data', token: 'xoxc-test' })
        // 3. fetchSlackModule('messages')
        .mockResolvedValueOnce({
            ok: true,
            status: 200,
            data: {
                messages: {
                    matches: [{
                        iid: 'msg1',
                        ts: MOCK_TS,
                        text: 'hello world',
                        channel: { id: MOCK_CHANNEL_ID, name: 'general' },
                        permalink: `https://test.enterprise.slack.com/archives/${MOCK_CHANNEL_ID}/p1700000000000001`,
                    }],
                },
            },
        })
        // 4. fetchSlackModule('files')
        .mockResolvedValueOnce({ ok: true, status: 200, data: { files: { matches: [] } } });

    mockLoadURL.mockResolvedValue(undefined);
});

describe('Slack Connector', () => {
    it('returns mapped results on success', async () => {
        const results = await searchSlack('hello');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].source).toBe('Slack');
        // Link is now the canonical Slack permalink (workspace-subdomain URL).
        expect(results[0].link).toContain(`/archives/${MOCK_CHANNEL_ID}/`);
        expect(results[0].type).toBe('Message');
    });

    it('throws AUTH_EXPIRED on token expiration', async () => {
        mockExecuteJavaScript
            .mockReset()
            // waitForSlackReady detects Slack login/sign-in page → throws AUTH_EXPIRED
            .mockResolvedValueOnce({ ready: true, isAuthPage: true, url: 'https://app.slack.com/signin' });
        await expect(searchSlack('test')).rejects.toThrow('AUTH_EXPIRED');
    });

    it('returns empty array on network failure', async () => {
        mockLoadURL.mockRejectedValue(new Error('Network error'));
        const results = await searchSlack('test');
        expect(results).toEqual([]);
    });
});

describe('Confluence Connector', () => {
    it('returns mapped results, normalizing webui paths with and without /wiki prefix', async () => {
        axios.get.mockResolvedValue({
            data: {
                results: [
                    // Shape A: webui already includes /wiki (older API style)
                    {
                        content: {
                            id: '100',
                            title: 'Setup Guide',
                            type: 'page',
                            _links: { webui: '/wiki/spaces/TEST/pages/100' },
                            space: { name: 'Engineering' },
                            version: { by: { displayName: 'Alice' }, when: '2024-01-01' },
                        },
                        excerpt: 'This is a setup guide',
                        score: 1,
                    },
                    // Shape B: webui WITHOUT /wiki (modern API — matches Ellucian's instance)
                    {
                        content: {
                            id: '200',
                            title: 'EDC Overview',
                            type: 'page',
                            _links: { webui: '/spaces/EDC/overview' },
                            space: { name: 'EDC' },
                            version: { by: { displayName: 'Bob' }, when: '2024-01-02' },
                        },
                        excerpt: 'EDC home',
                        score: 1,
                    },
                ],
            },
        });

        const results = await searchConfluence('setup');
        // 2 API hits + 1 synthetic portal shortcut = 3
        expect(results).toHaveLength(3);
        expect(results[0].source).toBe('Confluence');
        expect(results[0].type).toBe('Page');
        // Both shapes must end up with exactly one /wiki segment
        expect(results[0].link).toBe('https://test.atlassian.net/wiki/spaces/TEST/pages/100');
        expect(results[1].link).toBe('https://test.atlassian.net/wiki/spaces/EDC/overview');
        // Neither result should ever produce a double /wiki/wiki path
        expect(results[0].link).not.toContain('/wiki/wiki');
        expect(results[1].link).not.toContain('/wiki/wiki');
        // Portal shortcut last
        expect(results[2].type).toBe('Open in Confluence');
        expect(results[2].link).toContain('/wiki/search?text=setup');
    });
});

describe('ServiceNow Connector', () => {
    it('returns combined customer-cases, incidents and articles', async () => {
        // The new connector uses an in-page fetch via executeJavaScript instead
        // of axios. Mock the 4-call sequence the searchServiceNow runs:
        //   1. waitForServiceNowReady — page state probe
        //   2. fetchTable('sn_customerservice_case')
        //   3. fetchTable('incident')
        //   4. fetchTable('kb_article')
        mockExecuteJavaScript
            .mockReset()
            .mockResolvedValueOnce({ ready: true, hasGCK: true, isLoginPage: false, url: 'https://test.service-now.com/now/' })
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                data: { result: [{
                    sys_id: 'csc1',
                    number: 'CSC03766194',
                    short_description: 'Forms not loading',
                    description: 'Customer reports Forms blank screen',
                    state: '2',
                    priority: '2',
                    sys_created_on: '2024-01-15',
                    sys_updated_on: '2024-01-16',
                }] },
            })
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                data: { result: [{
                    sys_id: 'inc1',
                    number: 'INC001',
                    short_description: 'Login issue',
                    description: 'Cannot login',
                    state: '2',
                    priority: '2',
                    sys_created_on: '2024-01-01',
                }] },
            })
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                data: { result: [{
                    sys_id: 'kb1',
                    short_description: 'VPN guide',
                    text: '<p>VPN steps</p>',
                    kb_category: 'Networking',
                    sys_updated_on: '2024-01-02',
                }] },
            });
        mockLoadURL.mockResolvedValue(undefined);

        const results = await searchServiceNow('login');
        // 3 API hits + 1 synthetic portal shortcut = 4
        expect(results.length).toBe(4);
        expect(results.every((r) => r.source === 'ServiceNow')).toBe(true);
        // Cases come first
        expect(results[0].type).toBe('Customer Case');
        expect(results[0].title).toContain('CSC03766194');
        // Portal shortcut should be last
        expect(results[results.length - 1].type).toBe('Open in ServiceNow');
        expect(results[results.length - 1].link).toContain('/now/nav/ui/search/');
        expect(results[results.length - 1].link).toContain('search-term/login');
    });
});

describe('Atlassian Connector', () => {
    it('returns a portal shortcut for the query', async () => {
        const results = await searchAtlassian('data connect issues');
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('Atlassian');
        expect(results[0].link).toContain('/o/org-abc-123/search');
        expect(results[0].link).toContain('cloudId=cloud-xyz-456');
        // Spaces should be encoded as + (matching home.atlassian.com behaviour)
        expect(results[0].link).toContain('text=data+connect+issues');
    });

    it('throws AUTH_EXPIRED when org/cloud IDs are missing', async () => {
        tokenStore.save('atlassian', { cookieHeader: 'x=1', baseUrl: 'https://home.atlassian.com' });
        await expect(searchAtlassian('test')).rejects.toThrow('AUTH_EXPIRED');
    });
});

describe('Box Connector', () => {
    it('returns a portal shortcut for the query (spaces encoded as %20)', async () => {
        const results = await searchBox('data connect issues');
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('Box');
        expect(results[0].link).toBe('https://ellucian.app.box.com/folder/0/search?query=data%20connect%20issues');
    });

    it('throws when not authenticated', async () => {
        tokenStore.clear('box');
        await expect(searchBox('x')).rejects.toThrow('Box not authenticated');
    });
});

describe('Jira Connector', () => {
    it('returns a portal shortcut for the query (spaces encoded as +)', async () => {
        const results = await searchJira('data connect issues');
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('Jira');
        expect(results[0].link).toContain('/jira/rovo-search?page=1&sortKey=name&sortOrder=ASC&text=data+connect+issues');
        expect(results[0].link.startsWith('https://ellucian.atlassian.net')).toBe(true);
    });

    it('throws when not authenticated', async () => {
        tokenStore.clear('jira');
        await expect(searchJira('x')).rejects.toThrow('Jira not authenticated');
    });
});

describe('Resources Connector', () => {
    it('returns a portal shortcut for the query (spaces encoded as +)', async () => {
        const results = await searchResources('data connect');
        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('Resources');
        expect(results[0].link).toBe('https://resources.elluciancloud.com/search?content-lang=en-US&query=data+connect');
    });

    it('throws when not authenticated', async () => {
        tokenStore.clear('resources');
        await expect(searchResources('x')).rejects.toThrow('Resources not authenticated');
    });
});
