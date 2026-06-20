const anthropic = require('./anthropic');
const gemini = require('./gemini');
const openai = require('./openai');
const agentrouter = require('./agentrouter');
const agent = require('./agent');
const { selectSources } = require('./prompt');
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

    // Phase 2 — Content enrichment.
    // 1. selectSources() picks the top ~30 results by char budget.
    // 2. enrichResults() fetches full body content (Confluence page bodies,
    //    ServiceNow tickets + comments + work notes) for the top 8 of those
    //    in parallel with a 12s overall timeout. Sources without a fetcher
    //    (Slack, Jira/Atlassian/Box/Datadog/AWS/Resources/Website) pass
    //    through unchanged and keep their snippet-only payload.
    // The enriched array is then passed to the adapter — when fullContent
    // is present on a result, prompt.compactResult() inlines it instead of
    // (or alongside) the snippet, so the LLM reads the actual document
    // body, not just the search-result headline.
    const picked = selectSources(results || []);
    let enrichedPicked = picked;
    let enrichmentStats = null;
    if (picked.length > 0) {
        try {
            const before = picked.filter((r) => r.fullContent).length;
            enrichedPicked = await agent.enrichResults(picked, { maxToFetch: 8, maxChars: 4096 });
            const after = enrichedPicked.filter((r) => r.fullContent).length;
            enrichmentStats = { attempted: Math.min(8, picked.length), enriched: after - before };
        } catch (err) {
            logger.warn('Phase 6', `Enrichment failed (snippet-only fallback): ${err.message}`);
            enrichedPicked = picked;
        }
    }

    // Try the agent-augmented system prompt first. If the provider returns
    // empty text (Gemini safety filter, OpenAI content-policy refusal, etc.)
    // fall back ONCE to the static SYSTEM_PROMPT — narrower, less likely to
    // trip safety heuristics on enterprise-content searches. Without this
    // fallback the UI hangs on "Reading sources…" forever.
    let result;
    try {
        result = await adapter.synthesize({
            query,
            results,                  // kept for backward compat — adapter ignores when picked is set
            picked: enrichedPicked,   // ← NEW: pre-selected + enriched, adapter skips its own selectSources
            apiKey, onChunk, model, systemPrompt,
        });
    } catch (err) {
        const msg = String(err?.message || '');
        const isEmpty = /returned no answer text|NO_TEXT|finishReason=SAFETY|safety filter|content[_-]?policy/i.test(msg);
        const hadAgentPrompt = Boolean(systemPrompt);
        if (isEmpty && hadAgentPrompt) {
            logger.warn('Phase 6', `Adapter rejected agent prompt — retrying with static SYSTEM_PROMPT (${msg.slice(0, 120)})`);
            result = await adapter.synthesize({
                query,
                results,
                picked: enrichedPicked,
                apiKey, onChunk, model /* no systemPrompt → static fallback */,
            });
            if (result) result.agentFallback = true;
        } else {
            throw err;
        }
    }
    return { ...result, provider: providerId, intent: intentInfo, enrichment: enrichmentStats };
}

// Analyze a single ServiceNow case (case data + screenshots + knowledge base).
// Routes to the active provider's analyzeCase(). Currently only the OpenAI
// adapter implements it (vision via chat-completions); other providers get a
// clear, actionable error rather than a silent failure.
async function analyzeCase({ caseBundle, kbResults, onChunk }) {
    const providerId = resolveActiveProvider();
    if (!providerId) throw new Error('AI_NOT_CONFIGURED');
    const adapter = PROVIDERS[providerId];
    if (typeof adapter.analyzeCase !== 'function') {
        throw new Error(`Case analysis isn't supported by ${adapter.META.name} yet. Switch your active AI provider to OpenAI in Settings (it reads screenshots via vision).`);
    }
    const apiKey = tokenStore.getAiKey(providerId);
    if (!apiKey) throw new Error('AI_NOT_CONFIGURED');
    const model = tokenStore.getAiModel(providerId) || adapter.META.defaultModel;
    const result = await adapter.analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model });
    return { ...result, provider: providerId };
}

// Derive a handful of high-signal search queries from a case's text so the
// knowledge-base retrieval can match on exact error phrases / product+feature
// names, not just the short description. Uses the active provider's lightweight
// chat() helper; returns [] on any failure so the caller can fall back.
async function extractCaseQueries(caseText) {
    const providerId = resolveActiveProvider();
    if (!providerId) return [];
    const adapter = PROVIDERS[providerId];
    if (typeof adapter.chat !== 'function') return [];
    const apiKey = tokenStore.getAiKey(providerId);
    if (!apiKey) return [];
    const model = tokenStore.getAiModel(providerId) || adapter.META.defaultModel;
    const sys = 'You write search queries to find solutions for an enterprise support issue. Given the case text, output 3-4 short, high-signal queries: exact error phrases, product + feature names, and the core symptom. Output ONLY a JSON array of strings — no prose, no markdown.';
    const usr = `Case text:\n${String(caseText || '').slice(0, 4000)}\n\nReturn a JSON array of 3-4 search query strings.`;
    try {
        const out = await adapter.chat(sys, usr, { apiKey, model, maxTokens: 200 });
        const m = String(out).match(/\[[\s\S]*\]/);
        const arr = JSON.parse(m ? m[0] : out);
        return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim().length > 1).slice(0, 4) : [];
    } catch (err) {
        logger.warn('Phase 7', `Case query extraction failed (using short description only): ${err.message}`);
        return [];
    }
}

// Multi-turn chat for "Ask AI Expert". Routes to the active provider's
// expertChat(). Currently implemented by the OpenAI adapter.
async function expertChat({ messages, systemPrompt, onChunk }) {
    const providerId = resolveActiveProvider();
    if (!providerId) throw new Error('AI_NOT_CONFIGURED');
    const adapter = PROVIDERS[providerId];
    if (typeof adapter.expertChat !== 'function') {
        throw new Error(`Ask AI Expert isn't supported by ${adapter.META.name} yet. Switch your active AI provider to OpenAI in Settings.`);
    }
    const apiKey = tokenStore.getAiKey(providerId);
    if (!apiKey) throw new Error('AI_NOT_CONFIGURED');
    const model = tokenStore.getAiModel(providerId) || adapter.META.defaultModel;
    const result = await adapter.expertChat({ messages, systemPrompt, apiKey, onChunk, model });
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

module.exports = { listProviders, resolveActiveProvider, testKey, synthesize, synthesizeWithWeb, analyzeCase, extractCaseQueries, expertChat, PROVIDERS, ORDER };
