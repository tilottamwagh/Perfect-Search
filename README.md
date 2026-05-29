# PerfectSearch

> Unified enterprise desktop search across Slack, Confluence, ServiceNow, Atlassian Portal, Box, and Jira — with AI synthesis powered by your choice of Anthropic Claude, Google Gemini, or OpenAI.

PerfectSearch is an Electron desktop app that lets you search every enterprise tool you use from one search bar. Connect each source once via SSO, type a query, and see results from all sources interleaved, deduplicated, and ranked. Optionally ask the built-in AI to synthesize a cited answer.

![Sources](https://img.shields.io/badge/sources-6-blueviolet) ![AI providers](https://img.shields.io/badge/AI-Anthropic%20%7C%20Gemini%20%7C%20OpenAI-blue) ![Tests](https://img.shields.io/badge/tests-21%20passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

### 🔭 Unified search across 6 sources
- **Slack** — messages and files via `/api/search.all` with pagination
- **Confluence** — REST API with CQL queries (with portal-shortcut fallback)
- **ServiceNow** — Customer Cases (`sn_customerservice_case`), Incidents, KB articles
- **Atlassian Portal** — unified cross-product search shortcut
- **Box** — file & folder search shortcut
- **Jira** — Rovo search shortcut

### ✨ AI synthesis (BYOK — bring your own key)
Pick any one of three providers and PerfectSearch will read the search results and stream back a structured, citation-grounded answer:

| Provider | Default model | Free tier? |
|---|---|---|
| Google Gemini | `gemini-2.0-flash` | ✅ 1,500 req/day |
| OpenAI | `gpt-4o-mini` | No (very cheap) |
| Anthropic Claude | `claude-opus-4-7` | No |

Citations appear as `[1]`, `[2]` chips — click one to scroll to the cited result. The answer streams in real time with a typing-cursor effect.

### 🎨 Modern UI
- Dark mode + light mode + system theme (toggle in header)
- Inter font with proper antialiasing
- Glass-blur header, gradient logo, smooth animations
- Expandable result cards with full metadata, copy buttons, and a raw-JSON toggle for power users
- Source badges with distinct colors (Slack purple, Confluence blue, ServiceNow green, Atlassian sky, Box indigo, Jira cyan)

### 🔐 Privacy-first
- All credentials stored locally in encrypted electron-store
- Sessions never leave the user's machine
- Per-user isolated profiles — no shared state between installs
- No telemetry

## Quick start

```bash
git clone https://github.com/<your-org>/perfectsearch.git
cd perfectsearch
npm install
cp .env.example .env       # then edit the URLs to match your instances
npm start
```

After launch:
1. Click ⚙️ → **Connect** on each source you want to search → complete SSO
2. (Optional) Add an AI provider API key in the **PerfectSearch AI providers** section
3. Type a query — results stream in across all connected sources
4. Click **✨ Ask AI** for a synthesized cited answer

## Configuration

Copy `.env.example` to `.env` and adjust the URLs for your organization's instances:

```bash
SLACK_WORKSPACE_URL=https://your-workspace.enterprise.slack.com
CONFLUENCE_BASE_URL=https://your-org.atlassian.net
SERVICENOW_BASE_URL=https://your-instance.service-now.com
BOX_BASE_URL=https://your-org.app.box.com
JIRA_BASE_URL=https://your-org.atlassian.net
ATLASSIAN_BASE_URL=https://home.atlassian.com

MAX_RESULTS_PER_SOURCE=300
SEARCH_TIMEOUT_MS=45000
CACHE_TTL_MINUTES=15
SESSION_REFRESH_HOURS=8

# Set this to a 32+ character random string in production
ENCRYPTION_KEY=change-me-to-a-long-random-string
```

## Architecture

```
src/
├── main.js                       # Electron main process + IPC handlers
├── preload.js                    # contextBridge exposes window.perfectsearch
├── auth/
│   ├── session.js                # SSO login flows (hidden BrowserWindow)
│   └── tokenStore.js             # AES-encrypted token storage
├── connectors/
│   ├── slack.js                  # Slack search.all via in-page fetch
│   ├── confluence.js             # Confluence REST + portal shortcut
│   ├── servicenow.js             # 3-table search + portal shortcut
│   ├── atlassian.js              # home.atlassian.com search shortcut
│   ├── box.js                    # Box file search shortcut
│   ├── jira.js                   # Jira Rovo search shortcut
│   └── website.js                # FlexSearch website indexing
├── ai/
│   ├── index.js                  # provider dispatcher
│   ├── prompt.js                 # shared system prompt + source selection
│   ├── anthropic.js              # Claude SDK adapter
│   ├── gemini.js                 # Google Gemini REST adapter
│   └── openai.js                 # OpenAI REST adapter
├── search/
│   └── engine.js                 # parallel fan-out + dedup + scoring
└── renderer/                     # React + Tailwind UI
    ├── App.jsx
    ├── components/
    │   ├── SearchBar.jsx
    │   ├── ResultCard.jsx        # expand/collapse with all metadata
    │   ├── AIAnswer.jsx          # streaming markdown with citations
    │   ├── LoginPanel.jsx        # source + AI provider settings
    │   └── ...
    └── hooks/
        └── useTheme.js           # dark/light/system theme
```

### How each search runs
1. User types a query → 400ms debounce → `IPC: search:query`
2. Engine fans out to all 6 connectors in parallel via `Promise.allSettled`
3. Each connector returns `{ id, source, type, title, snippet, link, ..., extras }`
4. Results are scored, deduplicated by normalized URL, and sorted
5. Renderer shows them with source badges + filter pills

### How AI synthesis works
1. User clicks **✨ Ask AI** → top 30 results selected by score (capped at 24KB)
2. Each result is formatted with title, URL, author, channel, date, snippet
3. The active provider (Anthropic / Gemini / OpenAI) streams a citation-grounded answer
4. Citations like `[1]` are parsed and rendered as clickable chips that scroll to the source

## Building installers

```bash
npm run make
```

Output goes to `out/make/`:
- **Windows**: `PerfectSearch-1.0.0 Setup.exe` (Squirrel installer)
- **macOS**: `PerfectSearch.zip` (drag-to-Applications)
- **Linux**: `.deb` and `.rpm` packages

Cross-platform building requires the target OS (or GitHub Actions runners).

## Development

```bash
npm start                # run dev mode with hot reload
npm test                 # run Jest test suite (21 tests)
npm run lint             # ESLint flat config
npm run package          # build app bundle without installer
```

### Testing
21 tests across 3 suites:
- `tests/auth.test.js` — token store encryption + status
- `tests/connectors.test.js` — Slack, Confluence, ServiceNow, Atlassian, Box, Jira mocks
- `tests/search.test.js` — engine dedup, caching, parallel fan-out

## Known limitations

- **ServiceNow REST API** may return 401 on Customer Service portal instances where the user role lacks `rest_api_explorer`. The connector falls back to a one-click portal shortcut.
- **Slack desktop-app redirect**: the in-app side panel cannot render Slack messages reliably because Slack's web client redirects embedded webviews to the desktop app. Slack results open in the user's default browser instead (where they're already signed in).
- **Atlassian / Box / Jira** are currently shortcut-only — they open the provider's own search page in the user's browser. Real in-app result fetching for these requires OAuth client credentials from each provider.

## Tech stack

- **Electron 42** — desktop runtime
- **React 19** + **Tailwind CSS 3.4** — UI
- **Webpack 5** + **Babel 7** + **Electron Forge** — build
- **electron-store** with AES encryption — token persistence
- **FlexSearch** — local website index
- **axios** — REST calls
- **@anthropic-ai/sdk** — Claude integration with prompt caching and adaptive thinking
- **Jest** — testing

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

Built with [Claude Code](https://claude.com/claude-code).
