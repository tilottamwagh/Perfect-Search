const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('electron-store', () => {
    const store = {};
    return jest.fn().mockImplementation(() => ({
        set: (key, value) => { store[key] = value; },
        get: (key) => store[key],
        delete: (key) => { delete store[key]; },
        clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
    }));
});

const threadStore = require('../src/ai/expert/threadStore');

describe('Expert thread store', () => {
    beforeEach(() => {
        threadStore.list().forEach((t) => threadStore.remove(t.id));
    });

    it('creates a thread and auto-titles from the first user message', () => {
        const t = threadStore.create({});
        expect(t.id).toBeTruthy();
        expect(t.messages).toEqual([]);

        threadStore.appendMessage(t.id, { role: 'user', content: 'Why are SFRSTCR events not reaching EMA?' });
        const got = threadStore.get(t.id);
        expect(got.messages.length).toBe(1);
        expect(got.title).toMatch(/SFRSTCR events/);
    });

    it('lists threads and deletes them', () => {
        const a = threadStore.create({ title: 'A' });
        const b = threadStore.create({ title: 'B' });
        const ids = threadStore.list().map((x) => x.id);
        expect(ids).toContain(a.id);
        expect(ids).toContain(b.id);

        expect(threadStore.remove(a.id)).toBe(true);
        expect(threadStore.get(a.id)).toBeNull();
        expect(threadStore.list().map((x) => x.id)).not.toContain(a.id);
    });

    it('appends both user and assistant turns in order', () => {
        const t = threadStore.create({});
        threadStore.appendMessage(t.id, { role: 'user', content: 'hello' });
        threadStore.appendMessage(t.id, { role: 'assistant', content: 'hi, how can I help?' });
        const got = threadStore.get(t.id);
        expect(got.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });
});
