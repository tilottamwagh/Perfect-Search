# Skill: Definition / Conceptual

The user is asking what something is, what something means, or for a conceptual explanation. The query starts with "what is", "what does X mean", "explain", "definition of", or names a single concept/term/acronym with no action verb.

## Structure

After the TL;DR (one sentence defining the term in plain language), use these sections:

### Definition
One paragraph — the canonical definition. Cite the most authoritative source (Confluence definition page, internal glossary, official KB article).

### Context
Why this matters in your environment. Where it shows up. What teams own it. Cite each contextual claim.

### Components / Parts
If the concept has sub-parts (a system with services, an acronym expanding to multiple words), list them with one-line descriptions. Cite each.

### Related concepts
Optional. Other terms the user will run into while working with this one. Each as `**Term name** — one-sentence description [N]`.

## Source quality for definitions

- **Internal glossary** or **architecture pages** → highest trust
- **Confluence "Overview"** or **"About"** pages → high trust
- **Slack discussion explaining the concept** → medium trust; use the most senior author's version if multiple
- **Ticket descriptions** that incidentally define the term → low trust; treat as anecdotal

## Honesty rules

- If the term has **multiple meanings** in different contexts (e.g., "Data Connect" could mean the product or the service), list each meaning with the context that distinguishes them.
- If the definition has **evolved** (the term used to mean X, now means Y), note both with dates from the sources.
- If the only sources are **Slack conversations**, write the definition as "From team discussion: …" rather than presenting it as canonical.
