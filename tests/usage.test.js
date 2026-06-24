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

const usage = require('../src/ai/usage');

describe('Usage & cost tracker', () => {
    beforeEach(() => { usage.clear(); usage.setPricing({}); });

    it('computes cost from the pricing table and aggregates', () => {
        // gpt-5-mini default: in 0.25, out 2.00 per 1M → 1M+1M = 0.25 + 2.00 = 2.25
        const cost = usage.record({ feature: 'expert', model: 'gpt-5-mini', inTok: 1000000, outTok: 1000000 });
        expect(cost).toBeCloseTo(2.25, 2);

        const s = usage.summary();
        expect(s.all.cost).toBeCloseTo(2.25, 2);
        expect(s.today.count).toBe(1);
        expect(s.byFeature.expert.tok).toBe(2000000);
        expect(s.series.length).toBe(30);
    });

    it('honours an edited pricing table', () => {
        usage.setPricing({ 'gpt-5-mini': { in: 1, out: 1 } });
        const cost = usage.record({ feature: 'x', model: 'gpt-5-mini', inTok: 1000000, outTok: 0 });
        expect(cost).toBeCloseTo(1, 5);
    });

    it('tracks per-thread usage', () => {
        usage.record({ feature: 'expert', model: 'gpt-5-mini', inTok: 1000, outTok: 500, threadId: 't1' });
        usage.record({ feature: 'expert', model: 'gpt-5-mini', inTok: 2000, outTok: 0, threadId: 't2' });
        expect(usage.perThread('t1').inTok).toBe(1000);
        expect(usage.perThread('t1').outTok).toBe(500);
        expect(usage.perThread('t2').inTok).toBe(2000);
    });
});
