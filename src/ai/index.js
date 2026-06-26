const anthropic = require('./anthropic');
const gemini = require('./gemini');
const openai = require('./openai');
const agentrouter = require('./agentrouter');
const deepseek = require('./deepseek');
const agent = require('./agent');
const { selectSources } = require('./prompt');
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

const PROVIDERS = { anthropic, gemini, openai, agentrouter, deepseek };
// Order controls the auto-fallback chain when no provider is explicitly
// selected: pick the first one with a saved key. Anthropic and Gemini come
// first because they support Web Research; the OpenAI-compat providers
// (OpenAI itself, DeepSeek, Agent Router) come after.
const ORDER = ['anthropic', 'gemini', 'openai', 'deepseek', 'agentrouter'];

function listProviders() {
    return ORDER.map((id) => {
        const p = PROVIDERS[id];
        const userModel = tokenStore.getAiModel(id);
        return {
            ...p.META,
            configured: tokenStore.hasAiKey(id),
            activeModel: userModel || p.META.defaultModel,
            reasoning: tokenStore.getAiReasoning(id) || 'medium',
            // Reasoning effort only applies to OpenAI's gpt-5 / o-series.
            supportsReasoning: id === 'openai',
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

async function testKey(providerId, apiKey, model) {
    const p = PROVIDERS[providerId];
    if (!p) return { ok: false, error: `Unknown provider: ${providerId}` };
    // Pass the user-selected model so validation hits the model they'll
    // actually use (e.g. deepseek-v4-flash) rather than the adapter default,
    // which they might not have access to. Adapters ignore the 2nd arg if
    // they don't support it.
    return p.testKey(apiKey, model);
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

    // A failure is "recoverable" (worth retrying with a different prompt or a
    // different provider) when the model returned no usable text — Gemini's
    // empty-response / safety-filter, OpenAI content-policy refusals, etc.
    // Genuine errors (bad key, network down) are NOT recoverable and rethrow.
    const isRecoverable = (msg) =>
        /returned no answer text|returned an empty response|no data chunks|NO_TEXT|finishReason=SAFETY|safety filter|content[_-]?policy|blocked the (prompt|answer)/i.test(String(msg || ''));

    // Try one provider: agent-augmented prompt first, then a static-prompt
    // retry on the same provider if the agent prompt was rejected.
    const tryProvider = async (pid) => {
        const ad = PROVIDERS[pid];
        const key = tokenStore.getAiKey(pid);
        if (!ad || !key) throw new Error('AI_NOT_CONFIGURED');
        const mdl = tokenStore.getAiModel(pid) || ad.META.defaultModel;
        const reasoning = tokenStore.getAiReasoning(pid) || 'medium';
        try {
            return await ad.synthesize({ query, results, picked: enrichedPicked, apiKey: key, onChunk, model: mdl, systemPrompt, reasoning });
        } catch (err) {
            if (isRecoverable(err?.message) && systemPrompt) {
                logger.warn('Phase 6', `[${pid}] rejected agent prompt — retrying with static SYSTEM_PROMPT (${String(err.message).slice(0, 100)})`);
                const r = await ad.synthesize({ query, results, picked: enrichedPicked, apiKey: key, onChunk, model: mdl, reasoning /* static prompt */ });
                if (r) r.agentFallback = true;
                return r;
            }
            throw err;
        }
    };

    // Active provider first. If it fails recoverably (the recurring Gemini
    // empty-response on enterprise content), automatically fall through to the
    // next configured provider — OpenAI / Anthropic handle this content fine —
    // so the user gets an answer instead of a red error. Genuinely-broken
    // providers (no key) are skipped; non-recoverable errors rethrow.
    let result = null;
    let usedProvider = providerId;
    const tried = [];
    const fallbackOrder = [providerId, ...ORDER.filter((p) => p !== providerId && tokenStore.hasAiKey(p))];
    let lastErr = null;
    for (const pid of fallbackOrder) {
        try {
            tried.push(pid);
            result = await tryProvider(pid);
            usedProvider = pid;
            if (pid !== providerId) {
                logger.success('Phase 6', `Auto-fell back from ${providerId} to ${pid} after recoverable failure`);
                result.providerFallback = { from: providerId, to: pid };
            }
            break;
        } catch (err) {
            lastErr = err;
            if (isRecoverable(err?.message) && fallbackOrder.indexOf(pid) < fallbackOrder.length - 1) {
                logger.warn('Phase 6', `[${pid}] failed recoverably — trying next provider (${String(err.message).slice(0, 80)})`);
                continue; // try the next configured provider
            }
            throw err; // non-recoverable, or no more providers to try
        }
    }
    if (!result) throw (lastErr || new Error('AI synthesis failed across all configured providers.'));

    return { ...result, provider: usedProvider, intent: intentInfo, enrichment: enrichmentStats };
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
    const sys = 'You write search queries to find solutions for an enterprise support issue. Given the case text, output 3-4 short, high-signal queries: exact error phrases, product + feature names, and the core symptom. Output ONLY a JSON array of strings — no prose, no markdown, no code fences.';
    const usr = `Case text:\n${String(caseText || '').slice(0, 4000)}\n\nReturn a JSON array of 3-4 search query strings. Example: ["query one","query two","query three"]`;
    try {
        const out = String(await adapter.chat(sys, usr, { apiKey, model, maxTokens: 400 }) || '');
        if (!out.trim()) return [];
        // Strip code fences and reasoning preamble before the JSON array
        const m = out.match(/\[[\s\S]*?\]/);
        if (!m) return [];
        const arr = JSON.parse(m[0]);
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
