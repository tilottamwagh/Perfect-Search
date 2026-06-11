const anthropic = require('./anthropic');
const gemini = require('./gemini');
const openai = require('./openai');
const agentrouter = require('./agentrouter');
const agent = require('./agent');
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

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
    const adapter = PROVIDERS[providerId];
    const model = tokenStore.getAiModel(providerId) || adapter.META.defaultModel;

    // Phase 1 of the AI agent: classify the query's intent and compose a
    // skill-augmented system prompt before calling the adapter. If the
    // adapter exposes a `chat()` helper we use it for classification; if
    // not, the agent falls back to its synchronous keyword heuristic.
    let systemPrompt = null;
    let intentInfo = null;
    try {
        const classifyFn = typeof adapter.chat === 'function'
            ? (sys, usr) => adapter.chat(sys, usr, { apiKey, model, maxTokens: 256 })
            : null;
        const prepared = await agent.prepareAgentPrompt({
            query,
            classifyFn,
            // Keep the LLM classifier on by default. We can expose a user
            // setting to disable it later if cost/latency becomes an issue.
            useLLMClassifier: true,
        });
        systemPrompt = prepared.systemPrompt;
        intentInfo = prepared.intent;
    } catch (err) {
        logger.warn('Phase 6', `Agent prep failed (will fall back to static prompt): ${err.message}`);
    }

    // Try the agent-augmented system prompt first. If the provider returns
    // empty text (Gemini safety filter, OpenAI content-policy refusal, etc.)
    // fall back ONCE to the static SYSTEM_PROMPT — narrower, less likely to
    // trip safety heuristics on enterprise-content searches. Without this
    // fallback the UI hangs on "Reading sources…" forever.
    let result;
    try {
        result = await adapter.synthesize({ query, results, apiKey, onChunk, model, systemPrompt });
    } catch (err) {
        const msg = String(err?.message || '');
        const isEmpty = /returned no answer text|NO_TEXT|finishReason=SAFETY|safety filter|content[_-]?policy/i.test(msg);
        const hadAgentPrompt = Boolean(systemPrompt);
        if (isEmpty && hadAgentPrompt) {
            logger.warn('Phase 6', `Adapter rejected agent prompt — retrying with static SYSTEM_PROMPT (${msg.slice(0, 120)})`);
            result = await adapter.synthesize({ query, results, apiKey, onChunk, model /* no systemPrompt → static fallback */ });
            // Tag the result so the UI/log can see the fallback fired
            if (result) result.agentFallback = true;
        } else {
            throw err;
        }
    }
    return { ...result, provider: providerId, intent: intentInfo };
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
