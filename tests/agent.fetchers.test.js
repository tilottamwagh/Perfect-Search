const { describe, it, expect, beforeEach, jest: jestApi } = require('@jest/globals');

// Mock electron-store so requiring the token-store module doesn't blow up.
jest.mock('electron-store', () => {
    const store = {};
    return jest.fn().mockImplementation(() => ({
        set: (key, value) => { store[key] = value; },
        get: (key) => store[key],
        delete: (key) => { delete store[key]; },
        clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    }));
});

// Mock axios — every fetcher uses it for REST calls.
jest.mock('axios');
const axios = require('axios');

const tokenStore = require('../src/auth/tokenStore');
const { cleanHtml, slackMessageToText, truncate } = require('../src/ai/agent/extractor');
const { fetchConfluence, extractPageId } = require('../src/ai/agent/fetchers/confluence');
const { fetchServiceNow, detectTable, getSysId } = require('../src/ai/agent/fetchers/servicenow');
const { fetchOne, fetchMany, hasFetcher } = require('../src/ai/agent/fetchers');

beforeEach(() => {
    tokenStore.clearAll();
    if (axios.get && typeof axios.get.mockReset === 'function') axios.get.mockReset();
});

describe('extractor.cleanHtml', () => {
    it('returns empty string for null / non-string input', () => {
        expect(cleanHtml(null)).toBe('');
        expect(cleanHtml(undefined)).toBe('');
        expect(cleanHtml(42)).toBe('');
    });

    it('strips script / style / nav / footer', () => {
        const html = `<div>
            <script>alert('x')</script>
            <style>.a{}</style>
            <nav>Top nav</nav>
            <p>The real content</p>
            <footer>Footer chrome</footer>
        </div>`;
        const out = cleanHtml(html);
        expect(out).toContain('The real content');
        expect(out).not.toContain('alert');
        expect(out).not.toContain('Top nav');
        expect(out).not.toContain('Footer chrome');
    });

    it('preserves heading hierarchy as markdown', () => {
        const html = '<h1>Title</h1><h2>Section</h2><h3>Sub</h3><p>Body.</p>';
        const out = cleanHtml(html);
        expect(out).toMatch(/# Title/);
        expect(out).toMatch(/## Section/);
        expect(out).toMatch(/### Sub/);
        expect(out).toMatch(/Body\./);
    });

    it('preserves bullet lists', () => {
        const html = '<ul><li>One</li><li>Two</li><li>Three</li></ul>';
        const out = cleanHtml(html);
        expect(out).toMatch(/- One/);
        expect(out).toMatch(/- Two/);
        expect(out).toMatch(/- Three/);
    });

    it('truncates to maxChars at a paragraph break when possible', () => {
        const longBody = '<p>' + 'lorem ipsum dolor sit amet '.repeat(200) + '</p>';
        const out = cleanHtml(longBody, { maxChars: 500 });
        expect(out.length).toBeLessThanOrEqual(550);
        expect(out).toMatch(/truncated/i);
    });

    it('passes through plain text that fails HTML parsing gracefully', () => {
        const out = cleanHtml('just plain text, not html');
        expect(out).toContain('just plain text');
    });
});

describe('extractor.truncate', () => {
    it('returns text unchanged when within budget', () => {
        expect(truncate('short', 100)).toBe('short');
    });

    it('cuts at paragraph break when one is close to the limit', () => {
        const txt = 'paragraph one.\n\nparagraph two has lots of words to ensure budget is exceeded by far.';
        const out = truncate(txt, 30);
        expect(out).toContain('paragraph one');
        expect(out).toMatch(/truncated/);
    });
});

describe('extractor.slackMessageToText', () => {
    it('extracts plain text from a basic Slack message', () => {
        const msg = { text: 'Hello team, has anyone seen this 401 error?' };
        expect(slackMessageToText(msg)).toContain('401 error');
    });

    it('resolves @mentions and #channel mentions to readable form', () => {
        const msg = { text: 'cc <@U123|alice> please check <#C456|help-data>' };
        const out = slackMessageToText(msg);
        expect(out).toContain('@alice');
        expect(out).toContain('#help-data');
    });

    it('formats block-kit elements', () => {
        const msg = {
            text: 'top',
            blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: 'block body line' } },
            ],
        };
        const out = slackMessageToText(msg);
        expect(out).toContain('top');
        expect(out).toContain('block body line');
    });

    it('surfaces attachment fallback text', () => {
        const msg = { text: '', attachments: [{ fallback: 'Linked Confluence: SSO troubleshooting' }] };
        expect(slackMessageToText(msg)).toContain('SSO troubleshooting');
    });
});

describe('confluence.extractPageId', () => {
    it('extracts ID from /pages/{id}/ URL', () => {
        expect(extractPageId('https://x.atlassian.net/wiki/spaces/HELP/pages/123456/Title')).toBe('123456');
    });

    it('extracts ID from extras["Content ID"] when present', () => {
        expect(extractPageId('garbage', { 'Content ID': '789' })).toBe('789');
    });

    it('returns null for unrecognised URL with no extras', () => {
        expect(extractPageId('https://atlassian.com/some/other/path')).toBeNull();
    });

    it('parses legacy ?pageId=N query format', () => {
        expect(extractPageId('https://x.atlassian.net/wiki/display/foo?pageId=4242')).toBe('4242');
    });
});

describe('fetchConfluence', () => {
    it('returns null when not authenticated', async () => {
        const result = { source: 'Confluence', link: 'https://x.atlassian.net/wiki/spaces/X/pages/1/T' };
        expect(await fetchConfluence(result)).toBeNull();
    });

    it('returns null when no page ID can be extracted', async () => {
        tokenStore.save('confluence', { cookieHeader: 'c=1', baseUrl: 'https://x.atlassian.net' });
        expect(await fetchConfluence({ source: 'Confluence', link: 'https://x.atlassian.net/wiki/random' })).toBeNull();
    });

    it('returns cleaned full content + metadata on success', async () => {
        tokenStore.save('confluence', { cookieHeader: 'c=1', baseUrl: 'https://x.atlassian.net' });
        axios.get.mockResolvedValueOnce({
            data: {
                body: { storage: { value: '<h1>How to fix 401</h1><p>Check the SAML cert SAN.</p>' } },
                space: { name: 'Help' },
                version: { number: 4, when: '2026-05-31T00:00:00Z' },
            },
        });
        const out = await fetchConfluence({
            source: 'Confluence',
            link: 'https://x.atlassian.net/wiki/spaces/HELP/pages/999/T',
        });
        expect(out).not.toBeNull();
        expect(out.fullContent).toMatch(/How to fix 401/);
        expect(out.fullContent).toMatch(/SAML cert SAN/);
        expect(out.metadata.space).toBe('Help');
        expect(out.metadata.version).toBe(4);
    });

    it('returns null on HTTP failure', async () => {
        tokenStore.save('confluence', { cookieHeader: 'c=1', baseUrl: 'https://x.atlassian.net' });
        axios.get.mockRejectedValueOnce(new Error('HTTP 401'));
        const out = await fetchConfluence({
            source: 'Confluence',
            link: 'https://x.atlassian.net/wiki/spaces/HELP/pages/999/T',
        });
        expect(out).toBeNull();
    });
});

describe('servicenow.detectTable', () => {
    it('detects incident from snow-inc- prefix', () => {
        expect(detectTable({ id: 'snow-inc-abc123' })).toBe('incident');
    });

    it('detects KB from snow-kb- prefix', () => {
        expect(detectTable({ id: 'snow-kb-abc123' })).toBe('kb_knowledge');
    });

    it('detects customer-case from snow-case- prefix', () => {
        expect(detectTable({ id: 'snow-case-abc123' })).toBe('sn_customerservice_case');
    });

    it('falls back to URL parsing when id is missing', () => {
        expect(detectTable({ link: 'https://x.service-now.com/incident.do?sys_id=xyz' })).toBe('incident');
    });

    it('returns null when neither id nor URL matches', () => {
        expect(detectTable({ link: 'https://example.com/random' })).toBeNull();
    });
});

describe('servicenow.getSysId', () => {
    it('returns extras["Sys ID"] when present', () => {
        expect(getSysId({ extras: { 'Sys ID': 'abcd1234' } })).toBe('abcd1234');
    });

    it('extracts from URL sys_id= query', () => {
        expect(getSysId({ link: 'https://x.service-now.com/incident.do?sys_id=abcdef0123456789abcdef0123456789' }))
            .toBe('abcdef0123456789abcdef0123456789');
    });

    it('returns null for malformed link', () => {
        expect(getSysId({ link: 'no-sys-id-here' })).toBeNull();
    });
});

describe('fetchServiceNow', () => {
    it('returns null when not authenticated', async () => {
        const result = { source: 'ServiceNow', id: 'snow-inc-x', extras: { 'Sys ID': 'a'.repeat(32) } };
        expect(await fetchServiceNow(result)).toBeNull();
    });

    it('returns null when table cannot be detected', async () => {
        tokenStore.save('servicenow', { cookieHeader: 'c=1', baseUrl: 'https://x.service-now.com' });
        expect(await fetchServiceNow({ id: 'unknown-x', link: 'https://example.com' })).toBeNull();
    });

    it('returns full content for an incident on success', async () => {
        tokenStore.save('servicenow', { cookieHeader: 'c=1', baseUrl: 'https://x.service-now.com' });
        axios.get.mockResolvedValueOnce({
            data: {
                result: {
                    number: 'INC0123456',
                    short_description: 'Data Connect 401 in PPRD',
                    description: 'Users report 401 errors when…',
                    work_notes: '2026-05-30 09:12 - jane (Work notes)\nRestarted the service. Issue persists.',
                    state: 'Open',
                    priority: '3 - Moderate',
                    sys_updated_on: '2026-05-30 09:30:00',
                },
            },
        });
        const out = await fetchServiceNow({
            source: 'ServiceNow',
            id: 'snow-inc-abc',
            extras: { 'Sys ID': 'a'.repeat(32) },
        });
        expect(out).not.toBeNull();
        expect(out.fullContent).toMatch(/Data Connect 401 in PPRD/);
        expect(out.fullContent).toMatch(/Work notes/);
        expect(out.fullContent).toMatch(/Restarted the service/);
        expect(out.metadata.number).toBe('INC0123456');
        expect(out.metadata.table).toBe('incident');
    });

    it('returns full content for a KB article', async () => {
        tokenStore.save('servicenow', { cookieHeader: 'c=1', baseUrl: 'https://x.service-now.com' });
        axios.get.mockResolvedValueOnce({
            data: {
                result: {
                    number: 'KB0001234',
                    short_description: 'How to renew SSL certificates',
                    text: '<p>Step 1: Generate a new CSR…</p>',
                    workflow_state: 'published',
                },
            },
        });
        const out = await fetchServiceNow({
            source: 'ServiceNow',
            id: 'snow-kb-xyz',
            extras: { 'Sys ID': 'b'.repeat(32) },
        });
        expect(out.fullContent).toMatch(/How to renew SSL certificates/);
        expect(out.fullContent).toMatch(/Generate a new CSR/);
        expect(out.metadata.table).toBe('kb_knowledge');
    });
});

describe('fetchers dispatcher', () => {
    it('hasFetcher recognises supported sources only', () => {
        expect(hasFetcher('Confluence')).toBe(true);
        expect(hasFetcher('ServiceNow')).toBe(true);
        expect(hasFetcher('Slack')).toBe(false);
        expect(hasFetcher('Jira')).toBe(false);
        expect(hasFetcher('Datadog')).toBe(false);
        expect(hasFetcher('AWS')).toBe(false);
    });

    it('fetchOne returns null for unsupported source', async () => {
        const out = await fetchOne({ source: 'Slack', link: 'x' });
        expect(out).toBeNull();
    });

    it('fetchOne returns null for null / malformed input', async () => {
        expect(await fetchOne(null)).toBeNull();
        expect(await fetchOne({})).toBeNull();
    });

    it('fetchMany passes through unsupported results unchanged', async () => {
        const inputs = [
            { id: 's1', source: 'Slack', title: 'msg one', snippet: 'a' },
            { id: 's2', source: 'Jira',  title: 'shortcut', snippet: 'b' },
        ];
        const out = await fetchMany(inputs);
        expect(out).toHaveLength(2);
        expect(out[0].fullContent).toBeUndefined();
        expect(out[1].fullContent).toBeUndefined();
    });

    it('fetchMany enriches Confluence + ServiceNow in parallel and preserves order', async () => {
        tokenStore.save('confluence', { cookieHeader: 'c=1', baseUrl: 'https://x.atlassian.net' });
        tokenStore.save('servicenow', { cookieHeader: 'c=1', baseUrl: 'https://x.service-now.com' });
        axios.get.mockImplementation((url) => {
            if (url.includes('confluence') || url.includes('atlassian.net')) {
                return Promise.resolve({
                    data: {
                        body: { storage: { value: '<p>confluence body content</p>' } },
                        space: { name: 'Help' },
                        version: { number: 1, when: '2026-05-01' },
                    },
                });
            }
            return Promise.resolve({
                data: {
                    result: {
                        number: 'INC123',
                        short_description: 'snow body content',
                        description: 'detail',
                        state: 'Open',
                    },
                },
            });
        });

        const inputs = [
            { id: 'c1', source: 'Confluence', title: 'doc', link: 'https://x.atlassian.net/wiki/spaces/X/pages/1/T', snippet: 'x' },
            { id: 's1', source: 'Slack',      title: 'msg', snippet: 'y' },
            { id: 'n1', source: 'ServiceNow', id: 'snow-inc-abc', extras: { 'Sys ID': 'a'.repeat(32) }, snippet: 'z' },
        ];
        const out = await fetchMany(inputs);
        expect(out).toHaveLength(3);
        expect(out[0].source).toBe('Confluence');
        expect(out[0].fullContent).toMatch(/confluence body/);
        expect(out[1].source).toBe('Slack');
        expect(out[1].fullContent).toBeUndefined(); // not fetched
        expect(out[2].source).toBe('ServiceNow');
        expect(out[2].fullContent).toMatch(/snow body content/);
    });

    it('fetchMany respects maxToFetch and passes through the tail unchanged', async () => {
        tokenStore.save('confluence', { cookieHeader: 'c=1', baseUrl: 'https://x.atlassian.net' });
        axios.get.mockResolvedValue({
            data: { body: { storage: { value: '<p>hi</p>' } }, space: { name: 'S' }, version: { number: 1 } },
        });
        const ten = Array.from({ length: 10 }, (_, i) => ({
            id: `c${i}`,
            source: 'Confluence',
            link: `https://x.atlassian.net/wiki/spaces/X/pages/${i}/T`,
            snippet: 's',
        }));
        const out = await fetchMany(ten, { maxToFetch: 3 });
        expect(out).toHaveLength(10);
        const enrichedCount = out.filter((r) => r.fullContent).length;
        // Exactly 3 should be enriched; tail unchanged
        expect(enrichedCount).toBe(3);
    });
});
