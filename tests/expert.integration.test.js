const { describe, it, expect } = require('@jest/globals');

// The expert modules pull in connectors (electron) + stores (electron-store).
jest.mock('electron', () => ({
    BrowserWindow: jest.fn().mockImplementation(() => ({ webContents: { executeJavaScript: jest.fn() }, loadURL: jest.fn() })),
    session: { fromPartition: jest.fn(() => ({ cookies: { get: jest.fn() } })) },
}));
jest.mock('electron-store', () => {
    const store = {};
    return jest.fn().mockImplementation(() => ({
        set: (k, v) => { store[k] = v; },
        get: (k) => store[k],
        delete: (k) => { delete store[k]; },
        clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    }));
});

describe('Ask AI Expert — cross-phase integration', () => {
    it('Phase A: thread store + expertChat wiring', () => {
        const threadStore = require('../src/ai/expert/threadStore');
        expect(typeof threadStore.create).toBe('function');
        const t = threadStore.create({});
        threadStore.appendMessage(t.id, { role: 'user', content: 'hi' });
        expect(threadStore.get(t.id).messages.length).toBe(1);

        const openai = require('../src/ai/openai');
        expect(typeof openai.expertChat).toBe('function');
        expect(typeof openai.embed).toBe('function'); // Phase 0
    });

    it('Phase B: agent loop + tools', () => {
        const agent = require('../src/ai/expert/agent');
        expect(typeof agent.runExpertAgent).toBe('function');
        const names = agent.TOOL_SCHEMAS.map((t) => t.function.name);
        expect(names).toEqual(expect.arrayContaining(['recall_knowledge', 'search_sources', 'fetch_doc']));
        // recall_knowledge must be advertised first (used first).
        expect(names[0]).toBe('recall_knowledge');
    });

    it('Phase C: uploads — image + text extraction', async () => {
        const { processUpload } = require('../src/ai/expert/files');
        const img = await processUpload({ name: 'shot.png', mime: 'image/png', base64: 'AAAA' });
        expect(img.kind).toBe('image');
        const txt = await processUpload({ name: 'ema.log', mime: 'text/plain', base64: Buffer.from('ERROR No GUIDs were found in business event').toString('base64') });
        expect(txt.kind).toBe('text');
        expect(txt.text).toMatch(/No GUIDs were found/);
    });

    it('Phase 0: ingestion + knowledge recall', () => {
        const ingest = require('../src/ai/expert/ingest');
        expect(typeof ingest.buildIndex).toBe('function');
        expect(typeof ingest.cacheResults).toBe('function');
        expect(Array.isArray(ingest.DEFAULT_SEEDS) && ingest.DEFAULT_SEEDS.length).toBeTruthy();

        const knowledge = require('../src/ai/expert/knowledge');
        knowledge.clear();
        knowledge.addDocuments([{ source: 'Slack', title: 'EMA GUIDs', link: 'k1', text: 'No GUIDs were found' }]);
        expect(knowledge.keywordSearch('GUIDs', 5).some((d) => d.link === 'k1')).toBe(true);
    });

    it('Phase D: learning + feedback', () => {
        const ingest = require('../src/ai/expert/ingest');
        expect(typeof ingest.saveLearning).toBe('function');
        const knowledge = require('../src/ai/expert/knowledge');
        expect(typeof knowledge.bumpBoost).toBe('function');
        expect(typeof knowledge.getBoost).toBe('function');
        knowledge.bumpBoost(['k1'], 1);
        expect(knowledge.getBoost('k1')).toBe(1);
    });
});
