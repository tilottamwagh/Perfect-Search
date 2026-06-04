const anthropic = require('./anthropic');
const gemini = require('./gemini');
const openai = require('./openai');
const agentrouter = require('./agentrouter');
const tokenStore = require('../auth/tokenStore');

const PROVIDERS = { anthropic, gemini, openai, agentrouter };
// Order controls the auto-fallback chain when no provider is explicitly
// selected: pick the first one with a saved key. Anthropic and Gemini come
// first because they support Web Research; the OpenAI-compat providers
// (OpenAI itself, Agent Router) come after.
const ORDER = ['anthropic', 'gemini', 'openai', 'agentrouter'];

function listProviders() {
    return ORDER.map((id) => {
        const p = PROVIDERS[id];
        const userModel = tokenStore.getAiModel(id);
        return {
            ...p.META,
            configured: tokenStore.hasAiKey(id),
            activeModel: userModel || p.META.defaultModel,
        };
    });
}

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
    const model = tokenStore.getAiModel(providerId) || PROVIDERS[providerId].META.defaultModel;
    const result = await PROVIDERS[providerId].synthesize({ query, results, apiKey, onChunk, model });
    return { ...result, provider: providerId };
}

async function synthesizeWithWeb({ query, onChunk }) {
    const providerId = resolveActiveProvider();
    if (!providerId) throw new Error('AI_NOT_CONFIGURED');
    const adapter = PROVIDERS[providerId];
    if (!adapter.META.supportsWeb) {
        throw new Error(`WEB_NOT_SUPPORTED: ${adapter.META.name} does not support web research. Switch to Anthropic Claude or Google Gemini in Settings.`);
    }
    const apiKey = tokenStore.getAiKey(providerId);
    if (!apiKey) throw new Error('AI_NOT_CONFIGURED');
    const model = tokenStore.getAiModel(providerId) || adapter.META.defaultModel;
    const result = await adapter.synthesizeWithWeb({ query, apiKey, onChunk, model });
    return { ...result, provider: providerId };
}

module.exports = { listProviders, resolveActiveProvider, testKey, synthesize, synthesizeWithWeb, PROVIDERS, ORDER };
