require('dotenv').config();
const { BrowserWindow } = require('electron');
const yauzl = require('yauzl');
const tokenStore = require('../auth/tokenStore');
const session = require('../auth/session');
const logger = require('../utils/logger');

const SERVICENOW_PARTITION = 'persist:perfectsearch-servicenow';

// Keep only the lines that matter from a big log so we don't blow the model's
// context: error/exception/warn/reject lines, plus the head and tail for
// orientation. Caps the result to ~maxChars.
function smartSliceLog(text, maxChars = 8000) {
    const lines = String(text).split(/\r?\n/);
    if (lines.join('\n').length <= maxChars) return lines.join('\n');
    const signal = /error|exception|fail|warn|reject|refus|precondition|timeout|timed out|stack|caused by|unable|denied|null|missing|not found|invalid|fatal|severe|trigger|enabled|disabled|guid|mapped|translat|squash|retry|retried|\b401\b|\b403\b|\b500\b|\b503\b/i;
    const head = lines.slice(0, 30);
    const tail = lines.slice(-30);
    const hits = [];
    for (let i = 30; i < lines.length - 30; i += 1) {
        if (signal.test(lines[i])) hits.push(`${i + 1}: ${lines[i]}`);
        if (hits.length > 400) break;
    }
    let out = [
        '--- first lines ---', ...head,
        `--- ${hits.length} matching log line(s) (error/warn/reject/etc.) ---`, ...hits,
        '--- last lines ---', ...tail,
    ].join('\n');
    if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…(truncated)';
    return out;
}

// Heuristic: does a byte buffer look like text (so we read it) vs binary
// (xlsx/png/etc. — skip)? Samples the first 1KB.
function looksTextual(buf) {
    const n = Math.min(buf.length, 1024);
    if (n === 0) return false;
    let printable = 0;
    for (let i = 0; i < n; i += 1) {
        const b = buf[i];
        if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 160) printable += 1;
    }
    return printable / n > 0.85;
}

// Extract text content from a zip buffer (logs are very often shipped as a .zip
// on the case/task). Rather than trust file extensions (rotated logs like
// `ema.log.1`, `catalina.out`, gz'd logs, or no extension all get missed that
// way), we read EVERY entry, gunzip `.gz` entries, and keep the ones that sniff
// as text — smart-sliced and capped so a multi-MB archive can't overflow the
// prompt. Returns diagnostics (inspected/included/binary) for logging.
function extractZipText(buffer, { maxEntries = 12, maxPerEntry = 9000, maxTotal = 60000, maxEntryBytes = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
        const parts = [];
        const inspected = [];   // every file entry name seen
        const included = [];    // entries we extracted text from
        const binary = [];      // entries that sniffed as binary
        let total = 0;
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
            if (err || !zip) { resolve({ text: '', entries: [], inspected: [], binary: [], error: err && err.message }); return; }
            zip.readEntry();
            zip.on('entry', (entry) => {
                const name = entry.fileName;
                if (/\/$/.test(name)) { zip.readEntry(); return; } // directory
                inspected.push(name);
                if (included.length >= maxEntries || total >= maxTotal) { zip.readEntry(); return; }
                zip.openReadStream(entry, (e2, stream) => {
                    if (e2 || !stream) { zip.readEntry(); return; }
                    const chunks = [];
                    let bytes = 0;
                    stream.on('data', (c) => {
                        bytes += c.length;
                        if (bytes <= maxEntryBytes) chunks.push(c);
                        else stream.destroy();
                    });
                    const finish = () => {
                        try {
                            let raw = Buffer.concat(chunks);
                            if (/\.gz$/i.test(name)) { try { raw = require('zlib').gunzipSync(raw); } catch (_) { /* truncated/!gz — keep raw */ } }
                            if (looksTextual(raw)) {
                                const sliced = smartSliceLog(raw.toString('utf8'), maxPerEntry);
                                parts.push(`### ${name}\n${sliced}`);
                                included.push(name);
                                total += sliced.length;
                            } else {
                                binary.push(name);
                            }
                        } catch (_) { /* skip this entry */ }
                        zip.readEntry();
                    };
                    stream.on('end', finish);
                    stream.on('close', finish);
                    stream.on('error', () => { zip.readEntry(); });
                });
            });
            zip.on('end', () => resolve({ text: parts.join('\n\n'), entries: included, inspected, binary }));
            zip.on('error', () => resolve({ text: parts.join('\n\n'), entries: included, inspected, binary }));
        });
    });
}

// String-based text sniff: decoded binary contains U+FFFD replacement chars /
// control bytes; real text doesn't. Used to decide whether a downloaded
// attachment (e.g. a `.lis` with no recognised extension) is readable text.
function looksTextualStr(s) {
    const n = Math.min(s.length, 1024);
    if (!n) return false;
    let bad = 0;
    for (let i = 0; i < n; i += 1) {
        const c = s.charCodeAt(i);
        if (c === 0xFFFD) bad += 1;
        else if (c < 9 || (c > 13 && c < 32)) bad += 1;
    }
    return bad / n < 0.1;
}

// Read selected entries of a zip fully into UTF-8 strings (used to parse .xlsx,
// which is itself a zip of XML).
function readZipEntriesAsText(buffer, wantedTest, maxBytesPerEntry = 8 * 1024 * 1024) {
    return new Promise((resolve) => {
        const files = {};
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
            if (err || !zip) { resolve({ files, error: err && err.message }); return; }
            zip.readEntry();
            zip.on('entry', (entry) => {
                const name = entry.fileName;
                if (/\/$/.test(name) || !wantedTest(name)) { zip.readEntry(); return; }
                zip.openReadStream(entry, (e2, stream) => {
                    if (e2 || !stream) { zip.readEntry(); return; }
                    const chunks = []; let bytes = 0;
                    stream.on('data', (c) => { bytes += c.length; if (bytes <= maxBytesPerEntry) chunks.push(c); else stream.destroy(); });
                    const fin = () => { files[name] = Buffer.concat(chunks).toString('utf8'); zip.readEntry(); };
                    stream.on('end', fin); stream.on('close', fin); stream.on('error', () => zip.readEntry());
                });
            });
            zip.on('end', () => resolve({ files }));
            zip.on('error', () => resolve({ files }));
        });
    });
}

// Extract cell text from an .xlsx (a zip of XML): pull the shared-string table
// and each sheet's cell values into row-structured text, so the AI can read
// exports like SFASTCA_*.xlsx (affected GUIDs, action/status codes, dates).
async function extractXlsxText(buffer, { maxChars = 24000, maxRowsPerSheet = 600 } = {}) {
    const { files, error } = await readZipEntriesAsText(buffer, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(n));
    if (error) return { text: '', sheets: [], error };
    const decode = (s) => String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
        .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));

    const shared = [];
    const ss = files['xl/sharedStrings.xml'];
    if (ss) {
        const siRe = /<si\b[\s\S]*?<\/si>/g; let m;
        while ((m = siRe.exec(ss))) {
            const texts = [...m[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decode(x[1]));
            shared.push(texts.join(''));
        }
    }

    const sheets = [];
    const parts = [];
    let total = 0;
    const sheetNames = Object.keys(files).filter((n) => /worksheets\/sheet\d+\.xml$/i.test(n)).sort();
    for (const sn of sheetNames) {
        const xml = files[sn];
        const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
        const lines = [];
        for (const r of rows.slice(0, maxRowsPerSheet)) {
            const cells = [...r[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];
            const vals = cells.map((c) => {
                const attrs = c[1]; const inner = c[2];
                const vMatch = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
                if (/\bt="s"/.test(attrs) && vMatch) { const idx = parseInt(vMatch[1], 10); return shared[idx] != null ? shared[idx] : ''; }
                if (/\bt="(inlineStr|str)"/.test(attrs)) { return [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decode(x[1])).join(''); }
                if (vMatch) return decode(vMatch[1]);
                return '';
            }).filter((v) => v !== '');
            if (vals.length) lines.push(vals.join(' | '));
        }
        const sheetText = lines.join('\n');
        if (sheetText) { const block = `# Sheet ${sn.replace(/^.*\//, '')}\n${sheetText}`; parts.push(block); total += block.length; sheets.push(sn.replace(/^.*\//, '')); }
        if (total > maxChars) break;
    }
    let text = parts.join('\n\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
    return { text, sheets };
}

// Build a sysparm_query that matches either the record `number` exactly /
// by prefix (fast index lookup — important for "CSC03766194"-style searches)
// OR a LIKE scan of the given text fields (fallback for keyword queries).
// ServiceNow uses '^OR' as the OR separator between clauses.
function buildQuery(query, textFields) {
    const clauses = [
        `number=${query}`,
        `numberSTARTSWITH${query}`,
    ];
    for (const field of textFields) {
        clauses.push(`${field}LIKE${query}`);
    }
    return clauses.join('^OR');
}

const STATE_MAP = { 1: 'New', 2: 'In Progress', 3: 'On Hold', 4: 'Resolved', 5: 'Closed', 6: 'Cancelled' };
const PRIORITY_MAP = { 1: 'Critical', 2: 'High', 3: 'Moderate', 4: 'Low' };

async function createHiddenServiceNowWindow(url) {
    const win = new BrowserWindow({
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: SERVICENOW_PARTITION,
        },
    });

    await win.loadURL(url);
    return win;
}

// Performance Analytics dashboards (and other widget-heavy homepages) fire
// continuous async server transactions that saturate the session's concurrent-
// transaction slots. When our table queries land on the same session they queue
// behind those for 20–30s (`sesh_wait`) and time out. If the persistent window
// is sitting on such a page, move it to blank.do — a minimal ServiceNow page
// that still carries g_ck — so the session frees up. Navigation stays in the
// same window, so the session binding ServiceNow ties to it is preserved.
async function ensureLightweightServiceNowPage(win, baseUrl) {
    let url = '';
    try { url = win.webContents.getURL(); } catch (_) { /* window may be loading */ }
    if (/pa_dashboard|\$pa|\/dashboard|home\.do|homepage/i.test(url)) {
        logger.info('Phase 3', `ServiceNow window on heavy page — navigating to blank.do to free the session (was: ${url.slice(0, 80)})`);
        try {
            await win.webContents.loadURL(`${baseUrl}/nav_to.do?uri=blank.do`);
        } catch (err) {
            logger.warn('Phase 3', `Could not navigate ServiceNow window to blank.do: ${err && err.message}`);
        }
    }
}

async function waitForServiceNowReady(win, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const state = await win.webContents.executeJavaScript(
            `(function () {
                try {
                    return {
                        ready: document.readyState === 'complete',
                        url: window.location.href,
                        hasGCK: typeof window.g_ck === 'string' && window.g_ck.length > 0,
                        // If we landed on the IdP login page rather than ServiceNow,
                        // the session is gone — surface that as AUTH_EXPIRED.
                        isLoginPage: /okta\\.com|login|signin/i.test(window.location.href)
                            && !/service-now/i.test(window.location.href),
                        // session_timeout.do is ServiceNow's own dead-session page.
                        isSessionTimeout: /session_timeout\\.do/i.test(window.location.href),
                    };
                } catch (e) { return { ready: false, error: e.message }; }
            })();`,
            true
        );
        if (state.isLoginPage || state.isSessionTimeout) {
            throw new Error('AUTH_EXPIRED');
        }
        if (state.ready && state.hasGCK) {
            return state;
        }
        await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error('ServiceNow page did not initialise in time');
}

// Call ServiceNow REST API from *inside* the authenticated page context.
// This is the same pattern Slack uses: the in-page fetch automatically gets
// the right cookies, CSRF token, origin headers, and user-agent.
async function fetchTable(win, baseUrl, table, sysparmQuery, sysparmLimit, sysparmFields, perCallTimeoutMs = 10000) {
    // Hard per-call timeout via AbortController. ServiceNow serializes requests
    // on a single session, so if the persistent window is parked on a heavy
    // page (e.g. a Performance Analytics dashboard) every table query can stall
    // 20–30s waiting for the session lock — dragging the whole unified search
    // past 90s. We'd rather abort fast and fall back to the portal shortcut
    // than let one slow source blow the entire search budget. status=-1 is our
    // sentinel for "aborted by timeout".
    const script = `(async function () {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ${perCallTimeoutMs});
        try {
            const url = ${JSON.stringify(baseUrl)} + '/api/now/table/' + ${JSON.stringify(table)}
                + '?sysparm_query=' + encodeURIComponent(${JSON.stringify(sysparmQuery)})
                + '&sysparm_limit=' + ${sysparmLimit}
                + '&sysparm_fields=' + ${JSON.stringify(sysparmFields)};
            const resp = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                    'X-UserToken': window.g_ck || '',
                },
            });
            const txt = await resp.text();
            let data;
            try { data = JSON.parse(txt); } catch (_) { data = null; }
            // Capture response headers — WWW-Authenticate tells us if the
            // instance requires Basic/OAuth instead of session auth.
            const headerList = [];
            try { resp.headers.forEach((v, k) => { headerList.push(k + ': ' + v); }); } catch (_) {}
            return {
                status: resp.status,
                ok: resp.ok,
                data: data,
                raw: data ? null : txt.substring(0, 400),
                headers: headerList.join(' | '),
                gck: window.g_ck ? window.g_ck.substring(0, 12) + '...(' + window.g_ck.length + ')' : '(missing)',
                pageUrl: window.location.href,
            };
        } catch (err) {
            const aborted = err && err.name === 'AbortError';
            return { status: aborted ? -1 : 0, ok: false, aborted: aborted, error: err && err.message ? err.message : String(err) };
        } finally {
            clearTimeout(timer);
        }
    })();`;
    return win.webContents.executeJavaScript(script, true);
}

// Build a synthetic "open in ServiceNow" result that always appears so the
// user can jump to a working browser-side search even when our REST API path
// is blocked by ESC role / session restrictions.
//
// We use ServiceNow's *internal agent UI global search* URL — it searches the
// full Case/Incident/KB data the user has agent access to (the ESC portal
// search only covers customer-facing knowledge, which misses agent cases).
//
// The two hex IDs below are instance-specific sys_ids for Ellucian's global-
// search definition. If you point this app at a different ServiceNow instance,
// override them via SERVICENOW_SEARCH_SYS_ID and SERVICENOW_SEARCH_CONFIG_ID.
const ELLUCIAN_SEARCH_SYS_ID = process.env.SERVICENOW_SEARCH_SYS_ID
    || '0f8b85d0c7922010099a308dc7c2606a';
const ELLUCIAN_SEARCH_CONFIG_ID = process.env.SERVICENOW_SEARCH_CONFIG_ID
    || '6ebf8fe1531201107f03ddeeff7b122b';

function buildPortalShortcut(baseUrl, query) {
    // Build the agent-UI global-search deep link. Lowercasing the query
    // matches what ServiceNow itself does when the user types in the global
    // search box (the URL ends up with the lowercased term).
    const lowered = encodeURIComponent(query.toLowerCase());
    const url =
        `${baseUrl}/now/nav/ui/search/${ELLUCIAN_SEARCH_SYS_ID}`
        + `/params/search-term/${lowered}`
        + `/global-search-data-config-id/${ELLUCIAN_SEARCH_CONFIG_ID}`
        + `/back-button-label/${encodeURIComponent('PerfectSearch - ' + query)}`
        + `/search-context/${encodeURIComponent('now/nav/ui')}`;

    return {
        id: `snow-portal-${query}`,
        source: 'ServiceNow',
        type: 'Open in ServiceNow',
        title: `🔗 Search "${query}" in Ellucian Support (full agent search)`,
        snippet: 'Open this query in the ServiceNow agent UI — searches Cases, Incidents, KB, and more using your existing browser login. Use this if the case you need isn’t listed above.',
        link: url,
        date: null,
        score: 1, // Low so it sorts below real API hits; appears as a fallback.
    };
}

async function searchServiceNow(query) {
    const tokens = tokenStore.get('servicenow');
    if (!tokens) {
        throw new Error('ServiceNow not authenticated');
    }

    const totalMax = Number(process.env.MAX_RESULTS_PER_SOURCE || 300);
    const perTable = Math.ceil(totalMax / 3);
    const timeout = Number(process.env.SEARCH_TIMEOUT_MS || 15000);
    // Hard cap on each in-page table query so a session-locked ServiceNow can't
    // drag the unified search to 90s. The 3 table queries run concurrently, so
    // the connector's worst case is ~perCallTimeout, not 3× it.
    const perCallTimeout = Math.min(10000, Math.max(4000, Math.floor(timeout / 3)));
    const baseUrl = tokens.baseUrl || process.env.SERVICENOW_BASE_URL;
    const portalShortcut = buildPortalShortcut(baseUrl, query);

    // Reuse the persistent SSO window — Ellucian's ServiceNow binds sessions
    // to the originating window, so calls from a freshly-opened window get
    // redirected to session_timeout.do even with valid cookies.
    const win = session.getPersistentWindow('servicenow');
    if (!win) {
        // We can't do API calls but we can still surface the portal shortcut.
        logger.warn('Phase 3', 'No persistent ServiceNow window — returning portal shortcut only');
        return [portalShortcut];
    }

    try {
        logger.info('Phase 3', `Searching ServiceNow for "${query}" (max=${totalMax}, perTable=${perTable})`);

        // Move off any dashboard/heavy page first so the session isn't locked,
        // then wait for the (possibly newly navigated) page to be ready. Allow
        // a bit more time since this may include a navigation to blank.do.
        await ensureLightweightServiceNowPage(win, baseUrl);
        await waitForServiceNowReady(win, Math.min(9000, Math.floor(timeout / 2)));

        const caseQuery = buildQuery(query, ['short_description', 'description']);
        const incQuery = buildQuery(query, ['short_description', 'description']);
        const kbQuery = buildQuery(query, ['short_description', 'text']);

        const [casesRes, incidentsRes, articlesRes] = await Promise.allSettled([
            fetchTable(win, baseUrl, 'sn_customerservice_case', caseQuery, perTable,
                'sys_id,number,short_description,description,state,priority,account,contact,product,assigned_to,assignment_group,opened_by,sys_created_on,sys_updated_on,sys_class_name', perCallTimeout),
            fetchTable(win, baseUrl, 'incident', incQuery, perTable,
                'sys_id,number,short_description,description,state,priority,assigned_to,assignment_group,opened_by,caller_id,category,subcategory,sys_created_on,sys_updated_on', perCallTimeout),
            fetchTable(win, baseUrl, 'kb_article', kbQuery, perTable,
                'sys_id,number,short_description,text,kb_category,kb_knowledge_base,author,workflow_state,sys_view_count,sys_created_on,sys_updated_on', perCallTimeout),
        ]);

        const statusCodes = [];
        function unpack(res, label) {
            if (res.status !== 'fulfilled') {
                statusCodes.push(0);
                logger.warn('Phase 3', `ServiceNow ${label} rejected: ${res.reason && res.reason.message}`);
                return [];
            }
            const payload = res.value;
            statusCodes.push(payload.status || 0);
            if (!payload.ok) {
                logger.warn('Phase 3', `ServiceNow ${label} HTTP ${payload.status}: ${payload.error || payload.raw || '(no body)'}`);
                logger.warn('Phase 3', `  page=${payload.pageUrl || '?'} gck=${payload.gck || '?'}`);
                logger.warn('Phase 3', `  responseHeaders: ${payload.headers || '(none captured)'}`);
                return [];
            }
            return (payload.data && payload.data.result) || [];
        }

        // ServiceNow returns reference fields as either `{display_value, link}`
        // (when sysparm_display_value is true) or just the sys_id string. Helper
        // pulls a human-readable value out either way.
        const dv = (v) => (v && typeof v === 'object' && 'display_value' in v) ? v.display_value : v;

        const cases = unpack(casesRes, 'sn_customerservice_case').map((item) => ({
            id: `snow-case-${item.sys_id}`,
            source: 'ServiceNow',
            type: 'Customer Case',
            title: `${item.number}: ${item.short_description || '(no summary)'}`,
            snippet: (item.description || item.short_description || '').substring(0, 300),
            link: `${baseUrl}/nav_to.do?uri=sn_customerservice_case.do?sys_id=${item.sys_id}`,
            meta: `${STATE_MAP[item.state] || item.state || ''} | Priority: ${PRIORITY_MAP[item.priority] || item.priority || ''}`,
            date: item.sys_updated_on || item.sys_created_on,
            score: 0,
            extras: {
                'Sys ID': item.sys_id,
                'Case number': item.number,
                'State': STATE_MAP[item.state] || item.state || null,
                'Priority': PRIORITY_MAP[item.priority] || item.priority || null,
                'Account': dv(item.account),
                'Contact': dv(item.contact),
                'Product': dv(item.product),
                'Assigned to': dv(item.assigned_to),
                'Assignment group': dv(item.assignment_group),
                'Opened by': dv(item.opened_by),
                'Created': item.sys_created_on || null,
                'Updated': item.sys_updated_on || null,
                'Table': item.sys_class_name || 'sn_customerservice_case',
            },
        }));

        const incidents = unpack(incidentsRes, 'incident').map((item) => ({
            id: `snow-inc-${item.sys_id}`,
            source: 'ServiceNow',
            type: 'Incident',
            title: `${item.number}: ${item.short_description}`,
            snippet: (item.description || item.short_description || '').substring(0, 300),
            link: `${baseUrl}/nav_to.do?uri=incident.do?sys_id=${item.sys_id}`,
            meta: `${STATE_MAP[item.state] || item.state} | Priority: ${PRIORITY_MAP[item.priority] || item.priority}`,
            date: item.sys_created_on,
            score: 0,
            extras: {
                'Sys ID': item.sys_id,
                'Incident number': item.number,
                'State': STATE_MAP[item.state] || item.state || null,
                'Priority': PRIORITY_MAP[item.priority] || item.priority || null,
                'Category': dv(item.category),
                'Subcategory': dv(item.subcategory),
                'Assigned to': dv(item.assigned_to),
                'Assignment group': dv(item.assignment_group),
                'Opened by': dv(item.opened_by),
                'Caller': dv(item.caller_id),
                'Created': item.sys_created_on || null,
                'Updated': item.sys_updated_on || null,
            },
        }));

        const articles = unpack(articlesRes, 'kb_article').map((item) => ({
            id: `snow-kb-${item.sys_id}`,
            source: 'ServiceNow',
            type: 'KB Article',
            title: item.short_description,
            snippet: (item.text || '').replace(/<[^>]+>/g, '').substring(0, 300),
            link: `${baseUrl}/kb_view.do?sys_kb_id=${item.sys_id}`,
            meta: `Category: ${item.kb_category || 'General'}`,
            date: item.sys_updated_on,
            score: 0,
            extras: {
                'Sys ID': item.sys_id,
                'KB number': item.number,
                'Category': dv(item.kb_category),
                'Knowledge base': dv(item.kb_knowledge_base),
                'Author': dv(item.author),
                'Workflow state': item.workflow_state || null,
                'Views': item.sys_view_count != null ? Number(item.sys_view_count).toLocaleString() : null,
                'Created': item.sys_created_on || null,
                'Updated': item.sys_updated_on || null,
            },
        }));

        const apiResults = [...cases, ...incidents, ...articles];

        // If every table query hit our abort timeout (status -1), ServiceNow is
        // alive but throttling us — almost always because the persistent window
        // is parked on a heavy page holding the session lock. Surface that as a
        // distinct, actionable notice rather than a silent single result.
        const allTimedOut = apiResults.length === 0 && statusCodes.length > 0 && statusCodes.every((code) => code === -1);
        if (allTimedOut) {
            logger.warn('Phase 3', `ServiceNow table queries all timed out after ${perCallTimeout}ms (session likely locked by a dashboard) — returning portal shortcut`);
            portalShortcut._notice = `ServiceNow timed out after ${Math.round(perCallTimeout / 1000)}s — the session is busy (often a Performance Analytics dashboard holding the connection). Reconnect and let it land on the plain home screen, or retry in a moment. Showing the portal-search shortcut only.`;
            return [portalShortcut];
        }

        const allAuthFailed = statusCodes.length > 0 && statusCodes.every((code) => code === 401 || code === 403);
        if (allAuthFailed) {
            // The user's role doesn't allow REST API access (common for ESC
            // customer/employee users). Don't error out — return the portal
            // shortcut so the user can still get to their search in one click.
            // Tag it with a per-source notice so the UI explains the single
            // result instead of degrading silently. 401 vs 403 mean different
            // things: 401 = session not authenticated (reconnect & wait for the
            // home screen), 403 = role lacks table API access.
            logger.warn('Phase 3', 'ServiceNow REST API blocked (401/403 on all tables) — returning portal shortcut');
            portalShortcut._notice = statusCodes.includes(401)
                ? 'ServiceNow session not authenticated (HTTP 401) — the login window likely closed before SSO finished. Reconnect and wait until the ServiceNow home screen loads before the window closes.'
                : 'ServiceNow REST API access denied (HTTP 403) — your role lacks table API access. Showing the portal-search shortcut only.';
            return [portalShortcut];
        }

        // Append the portal shortcut at the end of the API hits so the user
        // can fall through to the full ServiceNow search if needed.
        const results = [...apiResults, portalShortcut];
        logger.success('Phase 3', `ServiceNow returned ${results.length} result(s) — cases=${cases.length}, incidents=${incidents.length}, kb=${articles.length}, +portal-shortcut`);
        return results;
    } catch (error) {
        // Any unexpected failure — still surface the portal shortcut so the
        // user has a usable path forward.
        logger.error('Phase 3', 'ServiceNow search failed (returning portal shortcut)', error);
        return [portalShortcut];
    }
    // NOTE: we do NOT close `win` — it's the persistent SSO window owned by
    // the auth/session module. It stays alive between searches so ServiceNow
    // keeps trusting its bound session.
}

// ───────────────────────────────────────────────────────────────────────────
// Case analysis — collect a single case's full record + comments/work notes +
// attachments so the AI layer can summarise it and propose troubleshooting.
// ───────────────────────────────────────────────────────────────────────────

// Pull sys_id (+ best-guess table) out of whatever ServiceNow URL the embedded
// webview happens to be on. Handles the common shapes:
//   .../now/cwf/agent/record/sn_customerservice_case/<sysid>
//   .../nav_to.do?uri=incident.do?sys_id=<sysid>
//   .../sn_customerservice_case.do?sys_id=<sysid>
//   ...?sys_id=<sysid>  (table unknown → caller falls back)
function parseCaseRef(rawUrl) {
    const url = decodeURIComponent(String(rawUrl || ''));
    const hex = '([0-9a-f]{32})';
    let table = null;
    let sysId = null;
    let caseNumber = null;

    // Synthetic scheme emitted by the renderer when only a case number is
    // visible in the DOM (ServiceNow workspace split-pane hides the sys_id).
    const numScheme = url.match(/^case-number:\/\/([A-Z0-9]+)$/i);
    if (numScheme) return { sysId: null, table: null, caseNumber: numScheme[1].toUpperCase() };

    const record = url.match(new RegExp(`/record/([a-z0-9_]+)/${hex}`, 'i'));
    if (record) { table = record[1]; sysId = record[2]; }

    if (!sysId) {
        const dotDo = url.match(new RegExp(`([a-z0-9_]+)\\.do[^a-z0-9_]*\\?[^]*?sys_id=${hex}`, 'i'));
        if (dotDo) { table = dotDo[1]; sysId = dotDo[2]; }
    }
    if (!sysId) {
        const bare = url.match(new RegExp(`sys_id=${hex}`, 'i'));
        if (bare) sysId = bare[1];
    }
    // Only trust real record tables, not UI pages like "nav_to" or "blank".
    if (table && /^(nav_to|blank|home|homepage|ui)$/i.test(table)) table = null;

    // Also try to extract a case/incident number directly from the URL for
    // use as a fallback display label or lookup key.
    if (!caseNumber) {
        const nm = url.match(/\b(CSC|INC|RITM|CHG|PRB)\d{6,}/i);
        if (nm) caseNumber = nm[0].toUpperCase();
    }

    return { sysId, table, caseNumber };
}

// Run an in-page fetch in an authenticated ServiceNow window and return parsed
// JSON (or an error envelope). Reused for the record, journal and attachment
// list. `win` must be a window bound to the ServiceNow session (the persistent
// SSO window).
async function inPageJson(win, absoluteUrl, perCallTimeoutMs = 12000) {
    const script = `(async function () {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), ${perCallTimeoutMs});
        try {
            const r = await fetch(${JSON.stringify(absoluteUrl)}, {
                method: 'GET', credentials: 'include', signal: c.signal,
                headers: { 'Accept': 'application/json', 'X-UserToken': window.g_ck || '' },
            });
            const txt = await r.text();
            let data; try { data = JSON.parse(txt); } catch (_) { data = null; }
            return { status: r.status, ok: r.ok, data, raw: data ? null : txt.slice(0, 300) };
        } catch (e) {
            return { status: 0, ok: false, error: e && e.message ? e.message : String(e) };
        } finally { clearTimeout(t); }
    })();`;
    return win.webContents.executeJavaScript(script, true);
}

// Download a single attachment in-page and return it base64-encoded (for
// images, fed to the vision model) or as decoded text (for logs/json/txt).
async function inPageAttachment(win, baseUrl, att, perCallTimeoutMs = 15000) {
    const fileUrl = `${baseUrl}/api/now/attachment/${att.sys_id}/file`;
    const isImage = /^image\//i.test(att.content_type || '');
    const isText = /^text\/|json|xml|log|csv/i.test(att.content_type || '') || /\.(log|txt|json|csv|xml|yaml|yml)$/i.test(att.file_name || '');
    const script = `(async function () {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), ${perCallTimeoutMs});
        try {
            const r = await fetch(${JSON.stringify(fileUrl)}, { method:'GET', credentials:'include', signal:c.signal, headers:{ 'X-UserToken': window.g_ck || '' } });
            if (!r.ok) return { ok:false, status:r.status };
            ${isImage
                ? `const blob = await r.blob(); const buf = await blob.arrayBuffer(); const bytes = new Uint8Array(buf); let bin=''; for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]); return { ok:true, kind:'image', base64: btoa(bin) };`
                : `const txt = await r.text(); return { ok:true, kind:'text', text: txt.slice(0, 8000) };`}
        } catch (e) {
            return { ok:false, error: e && e.message ? e.message : String(e) };
        } finally { clearTimeout(t); }
    })();`;
    void isText; // text path is the default branch above
    return win.webContents.executeJavaScript(script, true);
}

// Download any attachment in-page as base64 (used for binary files like .zip
// log archives that we then unpack in the Node main process).
async function inPageDownloadBase64(win, baseUrl, sysId, perCallTimeoutMs = 20000) {
    const fileUrl = `${baseUrl}/api/now/attachment/${sysId}/file`;
    const script = `(async function () {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), ${perCallTimeoutMs});
        try {
            const r = await fetch(${JSON.stringify(fileUrl)}, { method:'GET', credentials:'include', signal:c.signal, headers:{ 'X-UserToken': window.g_ck || '' } });
            if (!r.ok) return { ok:false, status:r.status };
            const blob = await r.blob(); const buf = await blob.arrayBuffer(); const bytes = new Uint8Array(buf);
            let bin=''; const CH=0x8000; for (let i=0;i<bytes.length;i+=CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i+CH));
            return { ok:true, base64: btoa(bin) };
        } catch (e) { return { ok:false, error: e && e.message ? e.message : String(e) }; } finally { clearTimeout(t); }
    })();`;
    return win.webContents.executeJavaScript(script, true);
}

// Download an attachment in-page as text (up to maxChars). Used for the sniff
// path so files with unrecognised extensions (e.g. Banner .lis listings) still
// get read if they turn out to be plain text.
async function inPageText(win, baseUrl, sysId, maxChars = 400000, perCallTimeoutMs = 15000) {
    const fileUrl = `${baseUrl}/api/now/attachment/${sysId}/file`;
    const script = `(async function () {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), ${perCallTimeoutMs});
        try {
            const r = await fetch(${JSON.stringify(fileUrl)}, { method:'GET', credentials:'include', signal:c.signal, headers:{ 'X-UserToken': window.g_ck || '' } });
            if (!r.ok) return { ok:false, status:r.status };
            const txt = await r.text();
            return { ok:true, text: txt.slice(0, ${maxChars}) };
        } catch (e) { return { ok:false, error: e && e.message ? e.message : String(e) }; } finally { clearTimeout(t); }
    })();`;
    return win.webContents.executeJavaScript(script, true);
}

// Fetch the comment/work-note journal for any record (case or task).
async function fetchJournal(win, baseUrl, sysId) {
    const jRes = await inPageJson(win, `${baseUrl}/api/now/table/sys_journal_field?sysparm_query=element_id=${sysId}^ORDERBYsys_created_on&sysparm_fields=element,value,sys_created_on,sys_created_by&sysparm_limit=100`);
    return (jRes.ok && jRes.data && jRes.data.result) ? jRes.data.result : [];
}

// Download attachments for one record (case or task), respecting a SHARED
// budget object { imagesLeft, textLeft, maxImageBytes } so the case and all its
// tasks together never exceed the overall image/text caps.
async function collectAttachments(win, baseUrl, tableSysId, budget, sourceLabel) {
    const aRes = await inPageJson(win, `${baseUrl}/api/now/attachment?sysparm_query=table_sys_id=${tableSysId}^ORDERBYsys_created_on&sysparm_fields=sys_id,file_name,content_type,size_bytes`);
    const meta = (aRes.ok && aRes.data && aRes.data.result) ? aRes.data.result : [];
    const images = [];
    const textFiles = [];
    const skipped = [];
    for (const att of meta) {
        const size = Number(att.size_bytes || 0);
        const ct = att.content_type || '';
        const name = att.file_name || '';
        const isImage = /^image\//i.test(ct);
        const isZip = /zip/i.test(ct) || /\.zip$/i.test(name);
        const isXlsx = /spreadsheetml|ms-excel/i.test(ct) || /\.xlsx?$/i.test(name);
        const isPdf = /pdf/i.test(ct) || /\.pdf$/i.test(name);
        if (isImage && budget.imagesLeft > 0 && size <= budget.maxImageBytes) {
            const dl = await inPageAttachment(win, baseUrl, att);
            if (dl.ok && dl.kind === 'image') { images.push({ fileName: name, contentType: ct, base64: dl.base64, source: sourceLabel }); budget.imagesLeft -= 1; }
            else skipped.push(`${name} (image dl failed)`);
        } else if (isXlsx && budget.textLeft > 0 && size <= budget.maxZipBytes) {
            // Excel exports (e.g. SFASTCA_*.xlsx) — xlsx is a zip of XML; parse
            // cell text so the affected GUIDs/records are visible to the model.
            const dl = await inPageDownloadBase64(win, baseUrl, att.sys_id);
            if (dl.ok && dl.base64) {
                try {
                    const buf = Buffer.from(dl.base64, 'base64');
                    const { text, sheets, error } = await extractXlsxText(buf);
                    logger.info('Phase 7', `Xlsx ${name}: ${buf.length}B, sheets=[${(sheets || []).join(', ')}], chars=${text.length}${error ? ` error=${error}` : ''}`);
                    if (text && text.trim()) { textFiles.push({ fileName: `${name} (xlsx)`, text, source: sourceLabel }); budget.textLeft -= 1; }
                    else skipped.push(`${name} (xlsx: no cell text${error ? '; ' + error : ''})`);
                } catch (e) { skipped.push(`${name} (xlsx parse failed: ${e && e.message})`); }
            } else skipped.push(`${name} (xlsx dl failed)`);
        } else if (isZip && budget.zipsLeft > 0 && size <= budget.maxZipBytes) {
            // Log archives — download, unzip in Node, extract the log text.
            const dl = await inPageDownloadBase64(win, baseUrl, att.sys_id);
            if (dl.ok && dl.base64) {
                try {
                    const buf = Buffer.from(dl.base64, 'base64');
                    const { text, entries, inspected, binary, error } = await extractZipText(buf);
                    logger.info('Phase 7', `Zip ${name}: ${buf.length}B, entries inside=[${(inspected || []).join(', ')}], extracted text=[${(entries || []).join(', ')}], binary=[${(binary || []).join(', ')}]${error ? ` error=${error}` : ''}`);
                    if (text && text.trim()) { textFiles.push({ fileName: `${name} (unzipped: ${entries.join(', ')})`, text, source: sourceLabel }); budget.zipsLeft -= 1; }
                    else skipped.push(`${name} (zip entries not text: ${(inspected || []).join(', ') || 'none'}${error ? '; ' + error : ''})`);
                } catch (e) { skipped.push(`${name} (unzip failed: ${e && e.message})`); }
            } else skipped.push(`${name} (zip dl failed)`);
        } else if (isPdf) {
            skipped.push(`${name} (PDF — not read)`);
        } else if (budget.textLeft > 0 && size <= budget.maxTextBytes) {
            // Sniff path: download as text and keep it if it's actually text.
            // Catches .lis (Banner GUREDIA/GUABEPR listings) and any other text
            // file regardless of its extension/content-type.
            const dl = await inPageText(win, baseUrl, att.sys_id);
            if (dl.ok && typeof dl.text === 'string' && dl.text.trim() && looksTextualStr(dl.text)) {
                textFiles.push({ fileName: name, text: smartSliceLog(dl.text, 12000), source: sourceLabel });
                budget.textLeft -= 1;
            } else if (dl.ok) {
                skipped.push(`${name} (${ct || 'unknown'} — not text)`);
            } else {
                skipped.push(`${name} (text dl failed)`);
            }
        } else {
            skipped.push(`${name} (${ct || 'unknown'}, ${size} bytes — not read)`);
        }
    }
    return { images, textFiles, skipped, count: meta.length };
}

// Collect everything needed to analyse a case: the case record + journal +
// attachments, PLUS its child tasks (e.g. CON*/CSTASK* records created on the
// case, which is where customers often attach the actual logs/screenshots) with
// their own journals and attachments. `win` is the authenticated ServiceNow
// window; `ref` is { sysId, table } from parseCaseRef.
async function collectCaseBundle(win, baseUrl, ref, { maxImages = 6, maxImageBytes = 5 * 1024 * 1024, maxTextFiles = 8, maxTextBytes = 8 * 1024 * 1024, maxTasks = 6, maxZips = 3, maxZipBytes = 30 * 1024 * 1024 } = {}) {
    const table = ref.table || 'sn_customerservice_case';
    const fields = 'sys_id,number,short_description,description,state,priority,account,contact,product,cmdb_ci,assigned_to,assignment_group,opened_by,caller_id,category,subcategory,sys_created_on,sys_updated_on,sys_class_name,close_notes,resolution_code';

    // 1. The record itself.
    const recRes = await inPageJson(win, `${baseUrl}/api/now/table/${table}/${ref.sysId}?sysparm_display_value=true&sysparm_fields=${fields}`);
    if (!recRes.ok || !recRes.data || !recRes.data.result) {
        const err = new Error(`Could not load case record (HTTP ${recRes.status}${recRes.error ? ': ' + recRes.error : ''})`);
        err.code = recRes.status;
        throw err;
    }
    const record = recRes.data.result;

    // 2. Case comments + work notes.
    const journal = await fetchJournal(win, baseUrl, ref.sysId);

    // Shared download budget across the case + all its tasks.
    const budget = { imagesLeft: maxImages, textLeft: maxTextFiles, maxImageBytes, maxTextBytes, zipsLeft: maxZips, maxZipBytes };

    // 3. Case attachments.
    const caseAtt = await collectAttachments(win, baseUrl, ref.sysId, budget, 'case');

    // 4. Child tasks. Query the base `task` table by parent — this catches any
    // child task type (CON*, CSTASK*, etc.) that extends task, regardless of
    // its specific table. Each task carries its own logs/screenshots.
    const relatedTasks = [];
    try {
        const taskFields = 'sys_id,number,short_description,description,state,sys_class_name,assigned_to,assignment_group,sys_created_on,sys_updated_on';
        const tRes = await inPageJson(win, `${baseUrl}/api/now/table/task?sysparm_query=parent=${ref.sysId}^ORDERBYsys_created_on&sysparm_display_value=true&sysparm_fields=${taskFields}&sysparm_limit=${maxTasks}`);
        const taskRecs = (tRes.ok && tRes.data && tRes.data.result) ? tRes.data.result : [];
        for (const t of taskRecs) {
            const tj = await fetchJournal(win, baseUrl, t.sys_id);
            const label = `task ${(t.number && (t.number.display_value || t.number)) || t.sys_id}`;
            const ta = await collectAttachments(win, baseUrl, t.sys_id, budget, label);
            relatedTasks.push({ record: t, journal: tj, images: ta.images, textFiles: ta.textFiles, skipped: ta.skipped, attachmentCount: ta.count });
        }
    } catch (e) {
        logger.warn('Phase 7', `Related-task fetch failed (continuing with case only): ${e && e.message}`);
    }

    // 5. Other related records that are NOT child tasks — notably
    // "Confidential Notes and Attachments" (table
    // sn_customerservice_conf_notes_attachments, number prefix CON*), which is
    // where customers frequently attach the actual logs (e.g. ema_logs_prod.zip)
    // but which is linked to the case by a reference field, not task.parent. We
    // try a few likely link-field names and use the first that matches.
    const relatedTables = (process.env.SERVICENOW_CASE_RELATED_TABLES || 'sn_customerservice_conf_notes_attachments')
        .split(',').map((s) => s.trim()).filter(Boolean);
    const candidateFields = ['parent', 'case', 'task', 'document_id', 'u_case'];
    for (const relTable of relatedTables) {
        try {
            let recs = [];
            let matchedField = null;
            for (const field of candidateFields) {
                const rRes = await inPageJson(win, `${baseUrl}/api/now/table/${relTable}?sysparm_query=${field}=${ref.sysId}^ORDERBYsys_created_on&sysparm_display_value=true&sysparm_fields=sys_id,number,short_description,description,state,sys_class_name,sys_created_on,sys_updated_on&sysparm_limit=${maxTasks}`);
                if (rRes.ok && rRes.data && rRes.data.result && rRes.data.result.length) { recs = rRes.data.result; matchedField = field; break; }
            }
            if (recs.length) {
                logger.info('Phase 7', `Related ${relTable}: ${recs.length} record(s) via field "${matchedField}"`);
                for (const r of recs) {
                    const rj = await fetchJournal(win, baseUrl, r.sys_id);
                    const num = (r.number && (r.number.display_value || r.number)) || r.sys_id;
                    const label = `${/conf/i.test(relTable) ? 'confidential note' : relTable} ${num}`;
                    const ra = await collectAttachments(win, baseUrl, r.sys_id, budget, label);
                    relatedTasks.push({ record: r, journal: rj, images: ra.images, textFiles: ra.textFiles, skipped: ra.skipped, attachmentCount: ra.count });
                }
            }
        } catch (e) {
            logger.warn('Phase 7', `Related-record fetch (${relTable}) failed: ${e && e.message}`);
        }
    }

    // Merge attachments (images budgeted globally) for the vision call.
    const images = [...caseAtt.images, ...relatedTasks.flatMap((t) => t.images)];
    const textFiles = [...caseAtt.textFiles, ...relatedTasks.flatMap((t) => t.textFiles)];
    const skipped = [...caseAtt.skipped, ...relatedTasks.flatMap((t) => t.skipped)];
    const attachmentCount = caseAtt.count + relatedTasks.reduce((s, t) => s + t.attachmentCount, 0);

    logger.info('Phase 7', `Case bundle: ${table}/${ref.sysId} — journal=${journal.length}, tasks=${relatedTasks.length}, attachments=${attachmentCount} (images=${images.length}, text=${textFiles.length}, skipped=${skipped.length})`);
    return { table, record, journal, relatedTasks, images, textFiles, skipped, attachmentCount, taskCount: relatedTasks.length };
}

module.exports = {
    searchServiceNow, parseCaseRef, collectCaseBundle,
    // Reusable file-text extractors (also used by Ask AI Expert uploads).
    extractZipText, extractXlsxText, smartSliceLog, looksTextualStr,
    // In-page authenticated JSON fetch (used by the KB crawler).
    inPageJson,
};
