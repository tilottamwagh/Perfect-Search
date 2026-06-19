// Shared prompt + source-selection logic used by every provider adapter.
// Keeping this in one place means switching providers doesn't change the
// answer style or grounding behaviour.

const SYSTEM_PROMPT = `You are PerfectSearch AI, an enterprise unified-search assistant.

Your job: read the user's query and the search results they collected from Slack, Confluence, ServiceNow, Atlassian, Box, and Jira — then synthesize a clear, well-organized answer.

Rules:
1. Cite sources using bracketed numbers like [1], [2] that refer to the numbered results below. Cite immediately after the claim they support.
2. Group related information. Use markdown headings (## section title), bullet points, and short paragraphs. Keep prose tight.
3. If the results don't contain enough information to answer the question, say so explicitly — do not invent details. Suggest follow-up keywords the user could try.
4. Distinguish between authoritative sources (Confluence pages, ServiceNow cases, KB articles) and conversational hints (Slack messages). Mention status/dates/owners when they're relevant.
5. Begin with a one-sentence TL;DR, then the structured body. End with a "Key sources" section listing the [N]: title pairs for the most relevant citations.
6. Be concise but complete. Do not pad with filler. Length should match the question's complexity.
7. If the query is a known identifier (CSC*, INC*, KB*, JIRA-*), prioritize the matching record first.

Output format: Markdown. No preamble like "Here is…" — just answer.`;

// System prompt for the single-case analysis feature (the "✨ Analyze case"
// button in the ServiceNow panel). Distinct from SYSTEM_PROMPT: the goal is not
// to answer a search query but to diagnose one support case end-to-end.
const CASE_ANALYSIS_SYSTEM_PROMPT = `You are PerfectSearch Case Analyst, an expert enterprise support engineer.

You are given ONE ServiceNow support case: its fields, the full comment/work-note history, ANY CHILD TASKS created on the case (with their own comments and attachments), the text of attached log/text files, attached screenshots (as images), and a set of KNOWLEDGE-BASE results (similar Slack threads, Confluence runbooks/product docs, ServiceNow KB articles, and past cases) gathered for this issue.

First, understand the problem like an engineer: read the customer's report and the comments/logs/screenshots carefully, identify the EXACT failing behaviour, pull out the concrete error messages / codes / symptoms, and reason about the underlying logic of what's going wrong (what component, what step in the workflow, what dependency). Then correlate that against the knowledge base and product docs to find matching guidance, similar past cases, and relevant KB articles.

Produce a focused diagnostic write-up with these markdown sections, in order:

## Summary
2–4 sentences: what the customer reported, the product/feature/environment involved, and current status. Mention if key diagnostics live in a child task.

## Key details
Tight bullets of the facts that matter — quote exact error messages/codes, versions, tenant/account, the specific feature/operation that failed, and what was already tried (from work notes / tasks). Explicitly note when a detail comes from a screenshot, a log file, or a child task (name it, e.g. "from task CON…").

## Most likely root cause
The 1–3 most probable causes, ranked, each with the evidence supporting it and the reasoning. Where relevant, identify the most likely CONFIGURATION or SETUP mistake — a setting that's wrong, missing, or mismatched between environments (test vs prod), a permission/role/license gap, a missing provisioning step, etc. If evidence is thin, say what's uncertain and what would confirm it.

## Configuration / setup checks
Concrete things to inspect in the product's configuration for this issue: which settings/fields/permissions/integration parameters to verify, expected vs likely-actual values, and what a correct setup looks like. Ground these in the product docs / KB where possible and cite [N].

## Troubleshooting / next steps
A numbered, ordered action plan the engineer can follow: what to check, what to reproduce, what to ask the customer, what to collect, and how to verify each step worked. Prefer steps grounded in the knowledge-base results, product docs, prior work notes, or how similar past cases were resolved — cite them with [N].

## Relevant references
The most relevant KB articles, Confluence/product-doc pages, and similar past cases, as [N]: title pairs, with a one-line note on why each is relevant.

Rules:
- Cite knowledge-base items with bracketed numbers [N] matching the numbered list provided. Cite right after the claim.
- Ground everything in the case data, attachments, child tasks, and knowledge base. Do NOT invent error codes, versions, KB numbers, or fixes. If the data is insufficient, say so and state exactly what additional info/logs/access would confirm the diagnosis.
- Be specific and actionable, written for a support engineer. No filler, no "Here is…" preamble — start directly with the ## Summary heading.`;

function compactResult(r, idx) {
    const lines = [];
    lines.push(`[${idx}] ${r.source}${r.type ? ' · ' + r.type : ''}`);
    if (r.title) lines.push(`Title: ${r.title}`);
    if (r.link) lines.push(`URL: ${r.link}`);
    if (r.author) lines.push(`Author: ${r.author}`);
    if (r.channel) lines.push(`Channel: #${r.channel}`);
    if (r.space) lines.push(`Space: ${r.space}`);
    if (r.meta) lines.push(`Meta: ${r.meta}`);
    if (r.date) {
        const d = new Date(r.date);
        if (!isNaN(d)) lines.push(`Date: ${d.toISOString().slice(0, 10)}`);
    }
    // Phase-2: when the agent's enrichment layer has fetched full body
    // content for this result (Confluence page, ServiceNow ticket +
    // comments, etc.), prefer the full body over the search-result
    // snippet. The LLM gets to read the actual document, not just the
    // search-result headline. Snippet is still surfaced as `Excerpt` so
    // the LLM has the matched-region hint.
    if (r.fullContent) {
        if (r.snippet) {
            const excerpt = String(r.snippet).replace(/\s+/g, ' ').trim().slice(0, 300);
            lines.push(`Excerpt: ${excerpt}`);
        }
        if (r.contentMeta) {
            const metaParts = [];
            if (r.contentMeta.space) metaParts.push(`space=${r.contentMeta.space}`);
            if (r.contentMeta.number) metaParts.push(`#${r.contentMeta.number}`);
            if (r.contentMeta.state) metaParts.push(`state=${r.contentMeta.state}`);
            if (r.contentMeta.assignedTo) metaParts.push(`assigned=${r.contentMeta.assignedTo}`);
            if (r.contentMeta.lastModified) metaParts.push(`modified=${r.contentMeta.lastModified.slice(0, 10)}`);
            if (metaParts.length) lines.push(`Source meta: ${metaParts.join(' · ')}`);
        }
        lines.push(`Full content:\n${r.fullContent}`);
    } else if (r.snippet) {
        const snip = String(r.snippet).replace(/\s+/g, ' ').trim().slice(0, 600);
        lines.push(`Content: ${snip}`);
    }
    return lines.join('\n');
}

function selectSources(results, { maxItems = 30, maxChars = 24000 } = {}) {
    const real = results.filter((r) => r && r.title && !/Open in (ServiceNow|Portal|Atlassian|Box|Jira|Confluence)/i.test(r.type || ''));
    const portalShortcuts = results.filter((r) => r && /Open in (ServiceNow|Portal|Atlassian|Box|Jira|Confluence)/i.test(r.type || ''));
    const picked = [];
    let chars = 0;
    for (const r of real) {
        if (picked.length >= maxItems) break;
        const block = compactResult(r, picked.length + 1);
        if (chars + block.length > maxChars) break;
        picked.push(r);
        chars += block.length;
    }
    for (const r of portalShortcuts) {
        if (picked.length >= maxItems) break;
        const block = compactResult(r, picked.length + 1);
        if (chars + block.length > maxChars) break;
        picked.push(r);
        chars += block.length;
    }
    return picked;
}

function buildUserMessage(query, picked) {
    const blocks = picked.map((r, i) => compactResult(r, i + 1)).join('\n\n');
    return `User query: ${query}\n\nSearch results (${picked.length} sources):\n\n${blocks}\n\nUsing only these sources, answer the query. Cite with [N].`;
}

// Flatten a ServiceNow reference field that may be {display_value,...} or a
// plain string into a readable value.
function dvText(v) {
    if (v && typeof v === 'object') return v.display_value || v.value || '';
    return v == null ? '' : String(v);
}

// Build the text half of the case-analysis user message from the bundle the
// connector collected plus the knowledge-base search results. Screenshots are
// attached separately by the adapter as image parts.
function buildCaseAnalysisText(caseBundle, kbResults) {
    const rec = caseBundle.record || {};
    const lines = [];
    lines.push('CASE RECORD');
    lines.push(`Number: ${dvText(rec.number)}`);
    if (rec.short_description) lines.push(`Short description: ${dvText(rec.short_description)}`);
    if (rec.sys_class_name || caseBundle.table) lines.push(`Table: ${dvText(rec.sys_class_name) || caseBundle.table}`);
    const metaPairs = [
        ['State', rec.state], ['Priority', rec.priority], ['Product', rec.product],
        ['Account', rec.account], ['Contact', rec.contact], ['Caller', rec.caller_id],
        ['Category', rec.category], ['Subcategory', rec.subcategory],
        ['Configuration item', rec.cmdb_ci], ['Assigned to', rec.assigned_to],
        ['Assignment group', rec.assignment_group], ['Opened by', rec.opened_by],
        ['Created', rec.sys_created_on], ['Updated', rec.sys_updated_on],
        ['Resolution code', rec.resolution_code],
    ];
    for (const [label, val] of metaPairs) {
        const t = dvText(val);
        if (t) lines.push(`${label}: ${t}`);
    }
    if (rec.description) lines.push(`\nDescription:\n${dvText(rec.description)}`);
    if (rec.close_notes) lines.push(`\nClose notes:\n${dvText(rec.close_notes)}`);

    // Comments & work notes, chronological.
    const renderJournal = (journal) => {
        for (const j of journal || []) {
            const kind = j.element === 'work_notes' ? 'work note' : 'comment';
            const who = dvText(j.sys_created_by);
            const when = (j.sys_created_on || '').slice(0, 16);
            const body = (j.value || '').replace(/\s+/g, ' ').trim();
            if (body) lines.push(`- [${kind}] ${when} ${who}: ${body}`);
        }
    };
    const journal = caseBundle.journal || [];
    if (journal.length) {
        lines.push('\nCOMMENTS & WORK NOTES (oldest first):');
        renderJournal(journal);
    }

    // Child tasks (CON*/CSTASK* etc.) created on the case — often where the
    // customer attached the real logs/screenshots and where engineers recorded
    // diagnostic steps.
    const tasks = caseBundle.relatedTasks || [];
    if (tasks.length) {
        lines.push(`\nRELATED TASKS ON THIS CASE (${tasks.length}):`);
        for (const t of tasks) {
            const r = t.record || {};
            lines.push(`\n— Task ${dvText(r.number)} (${dvText(r.sys_class_name)})${r.state ? ' · state=' + dvText(r.state) : ''}${r.assigned_to ? ' · assigned=' + dvText(r.assigned_to) : ''}`);
            if (r.short_description) lines.push(`  Short description: ${dvText(r.short_description)}`);
            if (r.description) lines.push(`  Description: ${dvText(r.description)}`);
            if ((t.journal || []).length) { lines.push('  Comments/work notes:'); renderJournal(t.journal); }
            for (const f of t.textFiles || []) lines.push(`  ATTACHED FILE (on ${dvText(r.number)}): ${f.fileName}\n${(f.text || '').trim()}`);
        }
    }

    // Attached text/log files on the case itself.
    const textFiles = (caseBundle.textFiles || []).filter((f) => f.source === 'case' || !f.source);
    for (const f of textFiles) {
        lines.push(`\nATTACHED FILE (on case): ${f.fileName}\n${(f.text || '').trim()}`);
    }

    // List screenshots (attached below as images) so the model can correlate
    // each image with where it came from (case vs a specific task).
    const images = caseBundle.images || [];
    if (images.length) {
        lines.push(`\nSCREENSHOTS ATTACHED AS IMAGES BELOW (${images.length}), in order:`);
        images.forEach((img, i) => lines.push(`  ${i + 1}. ${img.fileName}${img.source ? ` (from ${img.source})` : ''}`));
    }
    if (caseBundle.skipped && caseBundle.skipped.length) {
        lines.push(`(Not read: ${caseBundle.skipped.join('; ')}.)`);
    }

    // Knowledge-base context, numbered for citations.
    const kb = Array.isArray(kbResults) ? kbResults : [];
    if (kb.length) {
        const blocks = kb.map((r, i) => compactResult(r, i + 1)).join('\n\n');
        lines.push(`\nKNOWLEDGE-BASE RESULTS (${kb.length} — cite with [N]):\n\n${blocks}`);
    } else {
        lines.push('\nKNOWLEDGE-BASE RESULTS: none found for this case — rely on the case data and your expertise, and say what additional references would help.');
    }

    lines.push('\nAnalyze this case per your instructions. Cite knowledge-base items with [N].');
    return lines.join('\n');
}

module.exports = { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText };
