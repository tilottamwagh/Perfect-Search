const { describe, it, expect } = require('@jest/globals');

jest.mock('electron-store', () => {
    const store = {};
    return jest.fn().mockImplementation(() => ({
        set: (k, v) => { store[k] = v; },
        get: (k) => store[k],
        delete: (k) => { delete store[k]; },
        clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    }));
});

const { sourceOptions, TOOL_SCHEMAS } = require('../src/ai/expert/agent');

describe('Expert agent', () => {
    it('exposes the search and fetch tools', () => {
        const names = TOOL_SCHEMAS.map((t) => t.function.name);
        expect(names).toContain('search_sources');
        expect(names).toContain('fetch_doc');
    });

    it('defaults source options to fast text sources (+ ServiceNow KB), excluding noise', () => {
        const opts = sourceOptions([]);
        expect(opts.website).toBe(false);
        expect(opts.box).toBe(false);
        // slack/confluence/servicenow are left to the engine's defaults (not disabled)
        expect(opts.slack).toBeUndefined();
    });

    it('maps an explicit source subset to per-source flags', () => {
        const opts = sourceOptions(['slack', 'confluence']);
        expect(opts.slack).toBe(true);
        expect(opts.confluence).toBe(true);
        expect(opts.servicenow).toBe(false);
        expect(opts.jira).toBe(false);
    });
});
