# Skill: Status / State queries

The user is asking about the current state of something. The query uses "status of", "is X up", "what's happening with", "any updates on", or names an ongoing thing (incident, project, deployment).

## Structure

After the TL;DR (one sentence stating the current state in concrete terms — "X is in progress, blocked on Y" not "investigation continues"), use these sections:

### Current state
One paragraph. The most recent authoritative source wins. Lead with the *date* of that source so the user knows how fresh the answer is. Cite every claim.

### Timeline
Reverse-chronological bulleted list of state changes / updates / comments. Each entry:
- **Date** (YYYY-MM-DD)
- One-sentence summary of what happened
- Citation `[N]`
Keep to the 5–10 most recent / load-bearing entries. Older noise gets dropped.

### What's blocking it (if applicable)
Bullet list. Each blocker: who/what is the dependency, where it stands, citation.

### Owners
If the sources name people responsible (ticket assignee, channel owners, comment authors), list them with role. Cite each. Use names exactly as they appear in sources — don't normalize.

## Source quality for status

- **Most recent comment on the ticket / page** → highest trust for "current state"
- **Resolved/Closed status field** → authoritative for terminal state
- **Slack discussion in the last 48h** → high trust for recent updates
- **Page last-edited date** older than 30 days → cite as "as of <date>"; do not present old state as current

## Honesty rules

- If the most recent source is **stale** (older than a week for an active incident, older than a month for a project), say so explicitly: *"The most recent update I can see is from <date>. The current state may have changed since then."*
- If the sources **disagree** about state (Slack says fixed, ticket still open), describe both and recommend the user check the system of record.
- Never present a planned-state as current state. "Will be deployed Tuesday" is not the same as "is deployed".
- If the query asks about *something not in the results at all*, say: *"None of the available sources discuss the status of X. The most recent activity I see is on related item Y."*
