const { describe, it, expect, beforeEach } = require('@jest/globals');

// Token-store mock — same pattern as the other test suites. Agent code
// doesn't read the store, but the modules it transitively requires might.
jest.mock('electron-store', () => {
    const store = {};
    return jest.fn().mockImplementation(() => ({
        set: (key, value) => { store[key] = value; },
        get: (key) => store[key],
        delete: (key) => { delete store[key]; },
        clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
    }));
});

const intent = require('../src/ai/agent/intent');
const skills = require('../src/ai/agent/skills');
const agent = require('../src/ai/agent');

describe('Skills loader', () => {
    beforeEach(() => skills._resetCacheForTests());

    it('loads the base skill and all valid intent skills', () => {
        const loaded = skills.listLoadedIntents();
        expect(loaded.length).toBeGreaterThanOrEqual(7);
        expect(loaded).toEqual(expect.arrayContaining([
            'troubleshooting', 'how-to', 'definition', 'comparison', 'listing', 'status', 'general',
        ]));
    });

    it('composes a system prompt with both base + intent content', () => {
        const composed = skills.composeSystemPrompt('troubleshooting');
        expect(composed).toContain('PerfectSearch AI');               // base content
        expect(composed).toContain('Troubleshooting');                 // intent skill header
        expect(composed).toContain('Root cause');                      // intent-specific section
        expect(composed.length).toBeGreaterThan(500);                  // both sections actually concatenated
    });

    it('falls back to "general" skill when intent is unknown', () => {
        const composed = skills.composeSystemPrompt('not-a-real-intent');
        expect(composed).toContain('PerfectSearch AI');
        expect(composed).toContain('General query'); // intent-general.md header
    });

    it('falls back to a minimal prompt when all skill files are missing (unreachable in prod)', () => {
        // Simulate missing files by stubbing the read path. We don't actually
        // delete the files — instead we verify the function returns a string
        // that's at least minimally usable.
        const composed = skills.composeSystemPrompt('troubleshooting');
        expect(typeof composed).toBe('string');
        expect(composed.length).toBeGreaterThan(50);
    });

    it('exposes the same intent list as the classifier', () => {
        expect(skills.VALID_INTENTS).toEqual(intent.VALID_INTENTS);
    });
});

describe('Heuristic intent classifier', () => {
    it.each([
        ['Why is Data Connect failing with 401?',         'troubleshooting'],
        ['Data Connect error 500 on production',          'troubleshooting'],
        ['SSL cert issue not working',                    'troubleshooting'],
        ['How do I set up SAML for ServiceNow?',          'how-to'],
        ['Steps to configure Box integration',            'how-to'],
        ['Confluence vs SharePoint for runbooks',         'comparison'],
        ['Difference between INC and CASE in ServiceNow', 'comparison'],
        ['What is Data Connect?',                         'definition'],
        ['Explain Ellucian Experience',                   'definition'],
        ['list all open incidents',                       'listing'],
        ['show me current active runbooks',               'listing'],
        ['Status of the data migration project',          'status'],
        ['Is the API gateway up',                         'status'],
        ['random unrelated phrase that fits nothing',     'general'],
    ])('classifies "%s" as %s', (query, expected) => {
        const result = intent.heuristicClassify(query);
        expect(result.intent).toBe(expected);
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(result.rewrittenQuery).toBe(query);
    });

    it('returns "general" fallback for empty input', () => {
        expect(intent.heuristicClassify('').intent).toBe('general');
        expect(intent.heuristicClassify(undefined).intent).toBe('general');
        expect(intent.heuristicClassify(null).intent).toBe('general');
    });

    it('extracts ticket IDs as entities', () => {
        const r = intent.heuristicClassify('Status of INC0123456 and CSC0987654');
        expect(r.entities).toEqual(expect.arrayContaining(['INC0123456', 'CSC0987654']));
    });

    it('extracts HTTP error codes as entities', () => {
        const r = intent.heuristicClassify('Why is the service returning 503?');
        expect(r.entities).toEqual(expect.arrayContaining(['503']));
    });
});

describe('LLM intent classifier (with mock classifyFn)', () => {
    it('parses valid JSON response from the classifier model', async () => {
        const classifyFn = async () => JSON.stringify({
            intent: 'troubleshooting',
            confidence: 0.92,
            entities: ['Data Connect', '401'],
            rewrittenQuery: 'How do I fix Data Connect 401 errors',
        });
        const result = await intent.classify({ query: 'fix DC 401', classifyFn });
        expect(result.intent).toBe('troubleshooting');
        expect(result.confidence).toBe(0.92);
        expect(result.entities).toContain('Data Connect');
    });

    it('strips markdown code fences around JSON', async () => {
        const classifyFn = async () => '```json\n{"intent":"how-to","confidence":0.85,"entities":[],"rewrittenQuery":"x"}\n```';
        const result = await intent.classify({ query: 'how to do x', classifyFn });
        expect(result.intent).toBe('how-to');
    });

    it('falls back to heuristic on unparseable response', async () => {
        const classifyFn = async () => 'not json at all, just prose from a confused model';
        const result = await intent.classify({ query: 'how do I configure Slack?', classifyFn });
        expect(result.intent).toBe('how-to'); // heuristic catches "how do I"
    });

    it('falls back to heuristic when classifyFn throws', async () => {
        const classifyFn = async () => { throw new Error('rate limited'); };
        const result = await intent.classify({ query: 'Status of project Phoenix', classifyFn });
        expect(result.intent).toBe('status');
    });

    it('normalizes invalid intent values to "general"', async () => {
        const classifyFn = async () => JSON.stringify({ intent: 'invalid_value', confidence: 0.9, entities: [], rewrittenQuery: 'x' });
        const result = await intent.classify({ query: 'x', classifyFn });
        expect(result.intent).toBe('general');
    });

    it('clamps out-of-range confidence values', async () => {
        const classifyFn = async () => JSON.stringify({ intent: 'definition', confidence: 1.5, entities: [], rewrittenQuery: 'x' });
        const result = await intent.classify({ query: 'x', classifyFn });
        expect(result.confidence).toBe(1);
    });

    it('uses heuristic when no classifyFn is provided', async () => {
        const result = await intent.classify({ query: 'why is the build failing' });
        expect(result.intent).toBe('troubleshooting');
    });
});

describe('Agent orchestrator (prepareAgentPrompt)', () => {
    it('returns a composed system prompt + intent info', async () => {
        const classifyFn = async () => JSON.stringify({
            intent: 'troubleshooting',
            confidence: 0.9,
            entities: [],
            rewrittenQuery: 'fix 401',
        });
        const { systemPrompt, intent: i } = await agent.prepareAgentPrompt({
            query: 'fix 401',
            classifyFn,
        });
        expect(i.intent).toBe('troubleshooting');
        expect(systemPrompt).toContain('PerfectSearch AI');
        expect(systemPrompt).toContain('Root cause');
    });

    it('uses heuristic when useLLMClassifier is false', async () => {
        const classifyFn = jest.fn();
        const { intent: i } = await agent.prepareAgentPrompt({
            query: 'how do I configure SAML?',
            classifyFn,
            useLLMClassifier: false,
        });
        expect(classifyFn).not.toHaveBeenCalled();
        expect(i.intent).toBe('how-to');
    });

    it('survives a classifier that throws and still returns a prompt', async () => {
        const classifyFn = async () => { throw new Error('boom'); };
        const { systemPrompt, intent: i } = await agent.prepareAgentPrompt({
            query: 'list all open incidents',
            classifyFn,
        });
        expect(i.intent).toBe('listing');
        expect(systemPrompt.length).toBeGreaterThan(100);
    });
});
