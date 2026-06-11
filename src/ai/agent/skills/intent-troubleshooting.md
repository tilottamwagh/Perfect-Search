# Skill: Troubleshooting

The user is trying to fix something. The query mentions an error, failure, unexpected behavior, or asks "why isn't X working / why is Y failing".

## Structure

After the TL;DR (one sentence stating what's broken and likely cause), use these sections:

### Root cause
One short paragraph — what is actually broken, based on the most authoritative sources. Cite each claim. If sources disagree, name the disagreement instead of picking one silently.

### Fix
Numbered steps. Each step has:
- **The action** — a single verb-led sentence
- **Where** — the system or screen
- **Citation** — `[N]` pointing to the source that documents this step
- **Verification** — one short clause: how do you know the step worked

### If the fix doesn't work
1–3 bullet points of next things to try, with citations. Prefer KB articles and resolved tickets over speculation.

### Known related incidents
Optional. Only include if the results contain other tickets matching the same symptom. Format: `INC0123456 — short description [N]`.

## Source quality for troubleshooting

- ServiceNow **KB articles** → highest trust, treat as canonical
- Slack threads marked **resolved** (✅, "fixed", "thanks") → high trust
- Closed Jira issues with a **resolution field** → high trust
- Open Slack discussion → speculation; mark as such
- Multiple sources agreeing on the same fix → call it out as the consensus answer

## Honesty rules

- If the results contain only **questions** (no answers), say: *"The available sources describe this issue but none of them contain a confirmed fix. The closest match is [N] which is still open."*
- If the results contain a fix for a **superficially similar but actually different** problem (different service, different error code), do NOT present it as the answer. Flag the mismatch.
- Never combine the root cause from one incident with the fix from another unless the results explicitly cross-reference them.
