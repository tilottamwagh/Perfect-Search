# Privacy Policy

_Last updated: 2026-06-04_

PerfectSearch is an open-source desktop application distributed under the
MIT license. This policy explains what data the application handles and
how.

## TL;DR

PerfectSearch is a **local-only** desktop application. It does not
collect, transmit, store, or share any personal information with the
project authors or any third party operated by them. There is no
backend server, no analytics, no telemetry, and no remote logging.

All data the application uses stays on the user's own computer.

## What data PerfectSearch handles

PerfectSearch helps you search across enterprise tools you already use.
To do that, it handles three categories of data — all of which stay
local to your device.

### 1. Authentication tokens and session cookies

When you connect a source (Slack, Confluence, ServiceNow, Atlassian,
Box, Jira, Resources, Datadog, or AWS) PerfectSearch opens an embedded
browser window so you can sign in via your normal SSO flow. After a
successful login the application captures the session cookies and any
relevant access tokens issued by **that source's own servers**.

These tokens are:

- Stored only in an encrypted local file managed by `electron-store`
  on your machine (`%APPDATA%/PerfectSearch/` on Windows,
  `~/Library/Application Support/PerfectSearch/` on macOS,
  `~/.config/PerfectSearch/` on Linux)
- Never transmitted to any server operated by the PerfectSearch
  authors or any third party other than the source they belong to
- Used only to make search requests to the source that issued them

### 2. Search queries and search results

When you type a query, PerfectSearch sends that query to each
**source's own API** (Slack's, Confluence's, ServiceNow's, etc.)
using the tokens above. The results returned by those services are
displayed in the application and cached for up to 15 minutes in
memory.

Queries and results are never sent to any server operated by the
PerfectSearch authors.

### 3. AI provider API keys (optional)

If you choose to enable the optional "Ask AI" feature, you provide
your own API key for one of: Anthropic Claude, Google Gemini, OpenAI,
or Agent Router. Those keys are:

- Stored in the same encrypted local file as the source tokens
- Used only to send your selected search results to the AI provider
  you configured, so it can synthesize an answer
- Never transmitted to any server operated by the PerfectSearch
  authors

When you use the AI feature, the search results you have selected are
sent to the AI provider you chose — under that provider's own privacy
policy and terms of service. This is the same as making any direct
API call to that provider.

## What PerfectSearch does NOT do

- ❌ Does not run any backend server
- ❌ Does not collect analytics or telemetry
- ❌ Does not send crash reports or usage data anywhere
- ❌ Does not contain any third-party tracking code
- ❌ Does not transmit your search queries, results, tokens, or API
  keys to any server operated by the project authors

## Code signing

Windows installers downloaded from the
[Releases page](https://github.com/tilottamwagh/Perfect-Search/releases)
are code-signed using a certificate provided free of charge by the
[SignPath Foundation](https://signpath.org), managed on the
[SignPath.io](https://signpath.io) platform. Signing happens inside
GitHub Actions during the release build. The SignPath service receives
only the unsigned binary; it does not receive any user data.

## Third-party services

When you connect a source or use the AI feature, the relevant
third-party service receives data from your machine under its own
privacy policy. The third parties are:

- **Slack** (slack.com) — when Slack is connected
- **Atlassian** (atlassian.com / atlassian.net) — for Confluence,
  Jira, and the Atlassian Portal
- **ServiceNow** (service-now.com) — when ServiceNow is connected
- **Box** (box.com) — when Box is connected
- **Datadog** (datadoghq.com) — when Datadog is connected
- **Amazon Web Services** (aws.amazon.com / awsapps.com) — when
  AWS is connected
- **Ellucian Resources** (elluciancloud.com) — when Resources is
  connected
- **Anthropic, Google, OpenAI, or Agent Router** — only if you
  configure an AI provider key

Please consult those companies' own privacy policies for details
about how they handle data sent to them.

## Source code

PerfectSearch is open source. You can review the complete source code
on GitHub at <https://github.com/tilottamwagh/Perfect-Search> to verify
exactly what the application does with your data.

## Contact

For questions about this policy or about the project, open an issue at
<https://github.com/tilottamwagh/Perfect-Search/issues>.
