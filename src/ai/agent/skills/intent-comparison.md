# Skill: Comparison

The user is comparing two or more things. The query uses "vs", "versus", "compared to", "difference between", "which is better", or names two+ items with a comparison verb.

## Structure

After the TL;DR (one sentence stating the headline difference or recommendation), use these sections:

### At a glance
Markdown table comparing the items on the dimensions that matter for this query. Columns = items being compared, rows = dimensions. Cite each cell that contains a non-trivial claim. Keep rows under 8.

### Where they overlap
One short paragraph describing what the items have in common — only worth including if the overlap is non-obvious or load-bearing for the comparison.

### Where they differ
One sub-section per item, each titled with the item's name. List the distinctive features (3–5 bullets max). Cite each bullet.

### Recommendation
One paragraph. If the results contain explicit guidance ("we use X for production"), state it as the team's recommendation with citation. If they don't, write: "*The sources don't take an explicit position; here are the trade-offs to consider:*" and list them.

## Source quality for comparison

- **Architecture decision records (ADRs)** → highest trust for "which one we chose and why"
- **Design docs comparing options** → high trust
- **Slack threads where people advocate one side** → medium trust; note who said what
- **Old comparisons** (older than 6 months) → flag the date; tech has likely moved

## Honesty rules

- If the items are at **different maturity levels** (one production, one beta), say so before comparing — they're not really comparable as equivalents.
- If the comparison is **incomplete** (sources only describe one of the items in detail), say: *"Sources go deep on X but only mention Y in passing. The comparison below is asymmetric."*
- Never invent comparable dimensions just to fill out a table. If a row would be `?` for both items, omit the row.
