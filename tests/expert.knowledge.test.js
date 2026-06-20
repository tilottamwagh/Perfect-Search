const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('electron-store', () => {
    const store = {};
    return jest.fn().mockImplementation(() => ({
        set: (k, v) => { store[k] = v; },
        get: (k) => store[k],
        delete: (k) => { delete store[k]; },
        clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    }));
});

const knowledge = require('../src/ai/expert/knowledge');

describe('Expert knowledge index', () => {
    beforeEach(() => { knowledge.clear(); });

    it('computes cosine similarity', () => {
        expect(knowledge.cosine([1, 0], [1, 0])).toBeCloseTo(1, 5);
        expect(knowledge.cosine([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    it('adds documents and finds them by keyword', () => {
        const added = knowledge.addDocuments([
            { source: 'Slack', title: 'EMA rejected messages due to missing GUIDs', link: 'a', text: 'No GUIDs were found in business event' },
            { source: 'Confluence', title: 'BEP install runbook', link: 'b', text: 'configure CDC triggers' },
        ]);
        expect(added).toBe(2);
        const hits = knowledge.keywordSearch('GUIDs', 5);
        expect(hits.some((d) => d.link === 'a')).toBe(true);
    });

    it('dedupes by link on re-add', () => {
        knowledge.addDocuments([{ source: 'Slack', title: 'x', link: 'dup', text: 'y' }]);
        const addedAgain = knowledge.addDocuments([{ source: 'Slack', title: 'x', link: 'dup', text: 'y' }]);
        expect(addedAgain).toBe(0);
    });

    it('ranks semantic hits by embedding similarity', () => {
        knowledge.addDocuments([
            { source: 'A', title: 'near', link: 'n', text: 't', embedding: [1, 0, 0] },
            { source: 'B', title: 'far', link: 'f', text: 't', embedding: [0, 0, 1] },
        ]);
        const hits = knowledge.semanticSearch([0.9, 0.1, 0], 2);
        expect(hits[0].link).toBe('n');
    });

    it('hybrid recall returns merged results', () => {
        knowledge.addDocuments([
            { source: 'Slack', title: 'timeout in EMA dispatch', link: 't1', text: 'Found 1 timeout responses', embedding: [1, 0] },
            { source: 'Confluence', title: 'unrelated', link: 'u1', text: 'lorem', embedding: [0, 1] },
        ]);
        const hits = knowledge.recall('timeout', [1, 0], 5);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((d) => d.link === 't1')).toBe(true);
    });

    it('feedback boost reorders recall ranking', () => {
        knowledge.addDocuments([
            { source: 'A', title: 'alpha', link: 'a', text: 't', embedding: [1, 0] },
            { source: 'B', title: 'beta', link: 'b', text: 't', embedding: [0.6, 0.8] },
        ]);
        // Without boost, 'a' is closer to [1,0].
        let hits = knowledge.recall('zzz', [1, 0], 2);
        expect(hits[0].link).toBe('a');
        // A strong 👍 on 'b' should push it to the top.
        knowledge.bumpBoost(['b'], 1);
        knowledge.bumpBoost(['b'], 1);
        knowledge.bumpBoost(['b'], 1);
        knowledge.bumpBoost(['b'], 1);
        knowledge.bumpBoost(['b'], 1);
        expect(knowledge.getBoost('b')).toBe(5);
        hits = knowledge.recall('zzz', [1, 0], 2);
        expect(hits[0].link).toBe('b');
    });
});
