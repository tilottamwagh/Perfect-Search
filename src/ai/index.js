const anthropic = require('./anthropic');
const gemini = require('./gemini');
const openai = require('./openai');
const tokenStore = require('../auth/tokenStore');

const PROVIDERS = { anthropic, gemini, openai };
const ORDER = ['anthropic', 'gemini', 'openai'];

function listProviders() {
    return ORDER.map((id) => ({
        ...PROVIDERS[id].META,
        configured: tokenStore.hasAiKey(id),
    }));
}

// Find the provider to use for this request. Order of preference:
// 1. The explicitly selected active provider, if configured.
// 2. The first provider in ORDER that has a key set.
function resolveActiveProvider() {
    const selected = tokenStore.getActiveAiProvider();
    if (selected && tokenStore.hasAiKey(selected)) return selected;
    for (const id of ORDER) {
        if (tokenStore.hasAiKey(id)) return id;
    }
    return null;
}

async function testKey(providerId, apiKey) {
    const p = PROVIDERS[providerId];
    if (!p) return { ok: false, error: `Unknown provider: ${providerId}` };
    return p.testKey(apiKey);
}

async function synthesize({ query, results, onChunk }) {
    const providerId = resolveActiveProvider();
    if (!providerId) throw new Error('AI_NOT_CONFIGURED');
    const apiKey = tokenStore.getAiKey(providerId);
    if (!apiKey) throw new Error('AI_NOT_CONFIGURED');
    const result = await PROVIDERS[providerId].synthesize({ query, results, apiKey, onChunk });
    return { ...result, provider: providerId };
}

module.exports = { listProviders, resolveActiveProvider, testKey, synthesize, PROVIDERS, ORDER };
