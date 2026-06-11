const logger = require('../../utils/logger');

// Intent classifier — runs a small LLM call to bucket the user query into
// one of the supported intents. Falls back to `general` on failure so the
// rest of the pipeline never breaks.
//
// Output shape:
//   {
//     intent: 'troubleshooting'|'how-to'|'definition'|'comparison'|'listing'|'status'|'general',
//     confidence: 0..1,
//     entities: [string],
//     rewrittenQuery: string,
//   }
//
// We keep the classifier prompt tight and require strict JSON output so
// parsing is cheap and reliable. Output tokens are capped at 200 — plenty
// for the JSON structure, far less than the synthesize call.

const VALID_INTENTS = ['troubleshooting', 'how-to', 'definition', 'comparison', 'listing', 'status', 'general'];

const SYSTEM_PROMPT = `You are an intent classifier for an enterprise search assistant.

Classify the user's query into ONE of these intents:

- "troubleshooting" — user is trying to fix something broken (errors, failures, unexpected behaviour, "why isn't X working")
- "how-to" — user wants step-by-step instructions to accomplish a task ("how do I", "steps to", "process for")
- "definition" — user is asking what something is or means ("what is X", "explain Y", a single concept with no action verb)
- "comparison" — user is comparing two or more things ("X vs Y", "difference between", "which is better")
- "listing" — user wants an enumeration or catalog ("list all", "show me", a plural noun with no comparison)
- "status" — user is asking about the current state of something ongoing ("status of", "is X up", "any updates on")
- "general" — anything that doesn't cleanly fit the above

Also extract:
- key entities (product names, services, error codes, ticket IDs, version numbers — anything specific that a search would key off)
- a "rewrittenQuery" that clarifies the original query if it's vague or fragmented; otherwise return the original unchanged

Respond with VALID JSON only, no markdown fences, no prose. Schema:
{
  "intent": "<one of the values above>",
  "confidence": <number from 0.0 to 1.0>,
  "entities": ["..."],
  "rewrittenQuery": "..."
}`;

// Provider-aware classification — we don't want to add a hard dependency
// on a specific provider here, so we accept a `classifyFn` callback that
// each adapter exposes. The callback takes (systemPrompt, userPrompt) and
// returns the model's raw text response.

async function classify({ query, classifyFn }) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return fallback(query);
    }

    if (typeof classifyFn !== 'function') {
        logger.warn('Phase 6', 'No classifyFn provided — using heuristic intent fallback');
        return heuristicClassify(query);
    }

    const userPrompt = `Query: ${query.trim()}\n\nReturn the JSON now.`;
    const startedAt = Date.now();
    try {
        const raw = await classifyFn(SYSTEM_PROMPT, userPrompt);
        const parsed = parseJson(raw);
        if (!parsed) {
            logger.warn('Phase 6', 'Intent classifier returned unparseable JSON — falling back to heuristic');
            return heuristicClassify(query);
        }
        const normalized = normalize(parsed, query);
        const elapsed = Date.now() - startedAt;
        logger.info('Phase 6', `[intent] ${normalized.intent} (conf=${normalized.confidence.toFixed(2)}) in ${elapsed}ms`);
        return normalized;
    } catch (err) {
        logger.warn('Phase 6', `Intent classifier error: ${err.message} — using heuristic`);
        return heuristicClassify(query);
    }
}

function parseJson(raw) {
    if (!raw || typeof raw !== 'string') return null;
    // Try direct parse first
    try { return JSON.parse(raw.trim()); } catch (_) {}
    // Try extracting JSON from a code fence — some models wrap in ```json
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {}
    }
    // Try finding the first {...} block
    const braceMatch = raw.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try { return JSON.parse(braceMatch[0]); } catch (_) {}
    }
    return null;
}

function normalize(obj, originalQuery) {
    const intent = VALID_INTENTS.includes(obj.intent) ? obj.intent : 'general';
    let confidence = Number(obj.confidence);
    if (!Number.isFinite(confidence) || confidence < 0) confidence = 0.5;
    if (confidence > 1) confidence = 1;
    const entities = Array.isArray(obj.entities) ? obj.entities.filter((e) => typeof e === 'string' && e.length > 0).slice(0, 16) : [];
    const rewrittenQuery = typeof obj.rewrittenQuery === 'string' && obj.rewrittenQuery.length > 0 ? obj.rewrittenQuery : originalQuery;
    return { intent, confidence, entities, rewrittenQuery };
}

function fallback(query) {
    return { intent: 'general', confidence: 0.5, entities: [], rewrittenQuery: query || '' };
}

// Fast no-LLM fallback when the classifier call fails or is disabled.
// Keyword-based heuristic — not as accurate as the LLM call but better
// than always defaulting to 'general'. Synchronous, zero-cost.
function heuristicClassify(query) {
    const q = (query || '').toLowerCase();

    const has = (...patterns) => patterns.some((p) => p instanceof RegExp ? p.test(q) : q.includes(p));

    if (has(/\b(error|fail(ing|ed)?|broken|crash(es|ed|ing)?|not working|doesn'?t work|stuck|timeout|denied|forbidden|401|403|404|500|502|503|exception)\b/, 'why isn', 'why is.*not')) {
        return { intent: 'troubleshooting', confidence: 0.6, entities: extractEntities(query), rewrittenQuery: query };
    }
    if (has(/\b(how\s+(do|to|can|should)|steps?\s+to|guide\s+for|process\s+for|tutorial|walkthrough|setup|set\s+up|configure|install)\b/)) {
        return { intent: 'how-to', confidence: 0.6, entities: extractEntities(query), rewrittenQuery: query };
    }
    if (has(/\b(vs\.?|versus|compared?\s+to|difference\s+between|which\s+is\s+better|pros\s+and\s+cons)\b/)) {
        return { intent: 'comparison', confidence: 0.7, entities: extractEntities(query), rewrittenQuery: query };
    }
    // `is <X> (up|down|live)` — allow up to 4 intervening words so queries like
    // "is the API gateway up" or "is the data migration done" match.
    if (has(/\b(status\b|is\s+(?:\w+\s+){0,4}(up|down|live|done|complete|deployed|live|ready)\b|any\s+updates?\s+on|whats?\s+happening\s+with)/)) {
        return { intent: 'status', confidence: 0.6, entities: extractEntities(query), rewrittenQuery: query };
    }
    if (has(/\b(list|show\s+me|all\s+the|what\s+are\s+the)\b/)) {
        return { intent: 'listing', confidence: 0.55, entities: extractEntities(query), rewrittenQuery: query };
    }
    if (has(/\b(what\s+is|what\s+does|what'?s|explain|definition\s+of|meaning\s+of)\b/)) {
        return { intent: 'definition', confidence: 0.55, entities: extractEntities(query), rewrittenQuery: query };
    }
    return { intent: 'general', confidence: 0.4, entities: extractEntities(query), rewrittenQuery: query };
}

// Extract probable named entities — caps-words, IDs like INC0123456 or
// JIRA-1234, version numbers, error codes. Used by the heuristic fallback.
function extractEntities(query) {
    if (!query) return [];
    const out = new Set();
    const idPattern = /\b(?:CSC|INC|KB|JIRA|CHG|PRB|RITM|REQ|TASK)[-_]?\d{4,}\b/gi;
    let m;
    while ((m = idPattern.exec(query)) !== null) out.add(m[0]);
    const httpCodes = query.match(/\b[1-5]\d{2}\b/g) || [];
    httpCodes.forEach((c) => out.add(c));
    const capsWords = query.match(/\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+)*\b/g) || [];
    capsWords.forEach((w) => out.add(w));
    return [...out].slice(0, 8);
}

module.exports = {
    classify,
    heuristicClassify,
    VALID_INTENTS,
    SYSTEM_PROMPT,
    _testHelpers: { parseJson, normalize, extractEntities },
};
