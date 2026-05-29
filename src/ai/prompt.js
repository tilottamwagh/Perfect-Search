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
    if (r.snippet) {
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

module.exports = { SYSTEM_PROMPT, selectSources, buildUserMessage };
