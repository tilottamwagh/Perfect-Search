const { classify, heuristicClassify } = require('./intent');
const { composeSystemPrompt: composeFromSkills, VALID_INTENTS } = require('./skills');
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

module.exports = {
    prepareAgentPrompt,
    VALID_INTENTS,
};
