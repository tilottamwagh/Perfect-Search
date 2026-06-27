const tokenStore = require('../auth/tokenStore');

const PROVIDERS = {
    openai: require('./openai'),
    bedrock: require('./bedrock'),
    gemini: require('./gemini'),
};

const ORDER = ['openai', 'bedrock', 'gemini'];

function preferredProvider() {
    const active = tokenStore.getActiveAiProvider();
    if (active && PROVIDERS[active]?.embed && tokenStore.hasAiKey(active)) return active;
    for (const id of ORDER) {
        if (PROVIDERS[id]?.embed && tokenStore.hasAiKey(id)) return id;
    }
    return null;
}

function metaFrom(result, providerId) {
    const vector = (result?.vectors || []).find(Array.isArray);
    return {
        provider: result?.provider || providerId,
        model: result?.model || null,
        dimensions: result?.dimensions || vector?.length || null,
    };
}

async function embed(input, options = {}) {
    const providerId = options.provider || preferredProvider();
    if (!providerId) return { vectors: null, usage: { total_tokens: 0 }, provider: null, model: null, dimensions: null, unavailable: true };
    const adapter = PROVIDERS[providerId];
    const apiKey = tokenStore.getAiKey(providerId);
    if (!adapter?.embed || !apiKey) return { vectors: null, usage: { total_tokens: 0 }, provider: providerId, model: null, dimensions: null, unavailable: true };
    const result = await adapter.embed(input, { ...options, apiKey });
    const meta = metaFrom(result, providerId);
    return { ...result, ...meta, meta };
}

function providerLabel() {
    return preferredProvider() || null;
}

module.exports = { embed, preferredProvider, providerLabel };
