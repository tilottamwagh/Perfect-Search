const { classify, heuristicClassify } = require('./intent');
const { composeSystemPrompt: composeFromSkills, VALID_INTENTS } = require('./skills');
const { fetchMany } = require('./fetchers');
const logger = require('../../utils/logger');

// Phase-1 orchestrator — given a user query, decide which skill(s) to load
// and compose the system prompt that will be sent to the synthesize call.
//
// This module is the only place the rest of the codebase needs to touch:
//   const { prepareAgentPrompt } = require('./ai/agent');
//   const { systemPrompt, intent } = await prepareAgentPrompt({ query, classifyFn });
//
// `classifyFn` is provided by the caller (the active provider's adapter)
// so the classifier can run on whatever LLM the user has configured. If
// `classifyFn` is omitted, we fall back to the cheap synchronous keyword
// heuristic in intent.js — slightly less accurate but zero-cost and never
// blocks the main synthesize call.

async function prepareAgentPrompt({ query, classifyFn, useLLMClassifier = true }) {
    const startedAt = Date.now();
    let intentInfo;
    try {
        intentInfo = (useLLMClassifier && classifyFn)
            ? await classify({ query, classifyFn })
            : heuristicClassify(query);
    } catch (err) {
        logger.warn('Phase 6', `Agent intent prep failed: ${err.message} — using heuristic`);
        intentInfo = heuristicClassify(query);
    }

    const systemPrompt = composeFromSkills(intentInfo.intent);
    const elapsed = Date.now() - startedAt;
    logger.info('Phase 6', `[agent] system prompt composed for intent=${intentInfo.intent} (${systemPrompt.length} chars) in ${elapsed}ms`);

    return { systemPrompt, intent: intentInfo };
}

/**
 * Phase-2 enrichment — for the top-N search results, fetch the full body
 * content (Confluence page bodies, ServiceNow tickets + work notes /
 * comments). Returns the same array with `fullContent` populated on the
 * results that have a supported fetcher AND a successful fetch.
 *
 * Sources without a fetcher (Slack, Jira portal shortcut, Box, Datadog,
 * etc.) pass through unchanged — they keep their snippet only.
 *
 * Failure is silent on purpose: if fetching is slow, the network drops,
 * a cookie expired, or the body is parseable HTML we still want a
 * synthesise call to happen with whatever we got. We log success/failure
 * counts at INFO level so it's visible in the terminal.
 */
async function enrichResults(results, options = {}) {
    if (!Array.isArray(results) || results.length === 0) return results;
    try {
        return await fetchMany(results, options);
    } catch (err) {
        logger.warn('Phase 6', `Result enrichment failed (will use snippets only): ${err.message}`);
        return results;
    }
}

module.exports = {
    prepareAgentPrompt,
    enrichResults,
    VALID_INTENTS,
};
