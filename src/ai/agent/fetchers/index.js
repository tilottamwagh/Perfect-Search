const { fetchConfluence } = require('./confluence');
const { fetchServiceNow } = require('./servicenow');
const logger = require('../../../utils/logger');

// Source dispatcher — routes a search result to the fetcher that knows
// how to retrieve its full body content. Sources without a registered
// fetcher (portal shortcuts, Box files, Datadog/AWS deep links) return
// null and the synthesizer falls back to the snippet.
//
// Add a new source by exporting a `fetch{Source}(result, opts)` function
// that returns `{ fullContent: string, metadata?: object } | null` and
// registering it in the map below.

const FETCHERS = {
    Confluence: fetchConfluence,
    ServiceNow: fetchServiceNow,
    // Slack thread fetching needs an authenticated BrowserWindow which is
    // significantly heavier than a simple REST call — add in a follow-up
    // phase. Until then, Slack results are sent to the LLM at snippet
    // level (which is still meaningful since searchSlack already returns
    // a few hundred chars per message).
    // Jira, Atlassian, Box, Datadog, AWS, Resources, Website → portal
    // shortcuts only; no individual records to fetch.
};

function hasFetcher(source) {
    return typeof FETCHERS[source] === 'function';
}

/**
 * Fetch full content for a single result. Returns null on any failure
 * (network, auth, unsupported source) so the caller can fall back to the
 * snippet cleanly.
 */
async function fetchOne(result, opts = {}) {
    if (!result || !result.source) return null;
    const fn = FETCHERS[result.source];
    if (!fn) return null;
    try {
        return await fn(result, opts);
    } catch (err) {
        logger.warn('Phase 6', `[fetch:${result.source}] uncaught error: ${err.message}`);
        return null;
    }
}

/**
 * Fetch full content for a list of results in parallel with a global
 * timeout. Returns an array of `{ ...result, fullContent, contentMeta }`
 * — the original result spread, augmented with fetched body if any.
 *
 * Default budget: top 8 results, 5s per fetcher, 12s total.
 *
 * Order is preserved (matching input ordering) so the caller can use the
 * results directly for the LLM context with the highest-scoring items
 * still at the top.
 */
async function fetchMany(results, {
    maxToFetch = 8,
    maxChars = 4096,
    perFetchTimeoutMs = 5000,
    totalTimeoutMs = 12000,
} = {}) {
    if (!Array.isArray(results) || results.length === 0) return [];

    // Cap how many we actually try to enrich — the top-scoring ones get
    // priority. Everything else passes through unchanged (snippet only).
    const enrichable = results.slice(0, maxToFetch);
    const passThrough = results.slice(maxToFetch);

    const startedAt = Date.now();
    let attemptedCount = 0;
    let succeededCount = 0;

    const fetchPromises = enrichable.map(async (result) => {
        if (!hasFetcher(result.source)) {
            return result; // unchanged
        }
        attemptedCount++;
        try {
            const fetched = await Promise.race([
                fetchOne(result, { maxChars, timeoutMs: perFetchTimeoutMs }),
                new Promise((resolve) => setTimeout(() => resolve(null), perFetchTimeoutMs + 500)),
            ]);
            if (fetched && fetched.fullContent) {
                succeededCount++;
                return { ...result, fullContent: fetched.fullContent, contentMeta: fetched.metadata || null };
            }
            return result;
        } catch (_) {
            return result;
        }
    });

    // Race the batch against the global timeout. If we hit it, return
    // whatever has completed so far; the rest fall through as snippets.
    const finished = await Promise.race([
        Promise.all(fetchPromises),
        new Promise((resolve) => setTimeout(() => resolve(null), totalTimeoutMs)),
    ]);

    const elapsed = Date.now() - startedAt;
    const enriched = finished || await Promise.allSettled(fetchPromises).then((rs) => rs.map((r, i) => r.status === 'fulfilled' ? r.value : enrichable[i]));

    logger.info('Phase 6', `[fetch:batch] ${succeededCount}/${attemptedCount} enriched in ${elapsed}ms${finished ? '' : ' (timeout)'}`);

    return [...enriched, ...passThrough];
}

module.exports = {
    fetchOne,
    fetchMany,
    hasFetcher,
    FETCHERS,
};
