const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

// Skills are short markdown files that teach the LLM how to handle a
// specific intent. `_base.md` is always loaded; the intent-specific skill
// (intent-troubleshooting.md, intent-how-to.md, etc.) is loaded on demand
// based on the classified intent of the user's query.
//
// We read all skill files once at process start and cache them in memory.
// Skill files are tiny (<5 KB each) so the total cache is <50 KB. This
// avoids fs lookups on every synthesize call — important when running
// inside the packaged asar where fs is slightly slower.

const SKILLS_DIR = path.join(__dirname, 'skills');
const VALID_INTENTS = ['troubleshooting', 'how-to', 'definition', 'comparison', 'listing', 'status', 'general'];

let cache = null;

function loadSkillFile(name) {
    try {
        const filePath = path.join(SKILLS_DIR, name);
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
        logger.warn('Phase 6', `Failed to read skill file ${name}: ${err.message}`);
        return null;
    }
}

function loadAllSkills() {
    if (cache) return cache;
    cache = { base: null, byIntent: {} };
    cache.base = loadSkillFile('_base.md');
    for (const intent of VALID_INTENTS) {
        const content = loadSkillFile(`intent-${intent}.md`);
        if (content) cache.byIntent[intent] = content;
    }
    const loadedIntents = Object.keys(cache.byIntent).join(', ');
    logger.info('Phase 6', `Loaded ${Object.keys(cache.byIntent).length} intent skills + base skill (intents: ${loadedIntents})`);
    return cache;
}

// Test hook — clears the cache so test reloads work.
function _resetCacheForTests() {
    cache = null;
}

/**
 * Compose the full system prompt for a given intent.
 * Falls back to `general` if the intent isn't recognised or its skill
 * file is missing.
 */
function composeSystemPrompt(intent) {
    const skills = loadAllSkills();
    const normalizedIntent = VALID_INTENTS.includes(intent) ? intent : 'general';
    const intentSkill = skills.byIntent[normalizedIntent] || skills.byIntent.general || '';
    const baseSkill = skills.base || '';

    if (!baseSkill && !intentSkill) {
        // Skill files are missing entirely — return a minimal safety prompt
        // so synthesize still works. Should never happen in production.
        logger.warn('Phase 6', 'No skill files found — falling back to minimal system prompt');
        return 'You are PerfectSearch AI, an enterprise unified-search assistant. Answer the query using only the provided search results. Cite each claim with [N] referring to the numbered results below. Use markdown. Be concise.';
    }

    const sep = '\n\n---\n\n';
    return [baseSkill, intentSkill].filter(Boolean).join(sep);
}

function listLoadedIntents() {
    const skills = loadAllSkills();
    return Object.keys(skills.byIntent);
}

module.exports = {
    composeSystemPrompt,
    listLoadedIntents,
    VALID_INTENTS,
    _resetCacheForTests,
};
