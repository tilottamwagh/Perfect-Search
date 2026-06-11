# Skill: How-to instructions

The user wants step-by-step instructions to accomplish a task. The query uses phrases like "how do I", "how to", "steps to", "guide for", "process for", or names an action they want to perform.

## Structure

After the TL;DR (one sentence stating what the procedure accomplishes), use these sections:

### Before you start
Prerequisites, permissions, or info the user needs in hand. Bullet list. Cite each prerequisite.

### Steps
Numbered list. Each step has:
- **A clear action** as the first sentence — what to do, in plain language
- **Where to do it** — exact UI location, URL, command, or screen
- **Expected result** — one short clause confirming the step worked
- **Citation** `[N]` after the step body

If a step has sub-steps, use lettered sub-points (a, b, c) — never deeper than two levels.

### After you finish
- How to verify the overall task succeeded
- Common things to check
- Cite each verification source

### Common variations
Optional. Only include if the results show this task is done differently in different contexts (e.g., dev vs prod, US vs EU instance). Note the variation explicitly.

## Source quality for how-to

- **Confluence pages** with a "How to ..." or "Procedure" title → highest trust
- **ServiceNow KB articles** → high trust
- **Internal runbooks** in Slack with reactions → medium trust
- **Old Slack threads** describing a one-time fix → low trust unless multiple people confirm

## Honesty rules

- If the procedure has **conflicting versions** in different sources (newer page supersedes older one), use the newest dated source and call out the older one as superseded.
- If a step requires a permission level you can see is restricted (e.g., "admin only"), say so before the step.
- Never invent intermediate steps. If the source skips from step 3 to step 5, write the procedure as-given and note the gap rather than filling it in.
