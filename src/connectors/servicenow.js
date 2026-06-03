require('dotenv').config();
const { BrowserWindow } = require('electron');
const tokenStore = require('../auth/tokenStore');
const session = require('../auth/session');
const logger = require('../utils/logger');

const SERVICENOW_PARTITION = 'persist:perfectsearch-servicenow';

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
async function fetchTable(win, baseUrl, table, sysparmQuery, sysparmLimit, sysparmFields) {
    const script = `(async function () {
        try {
            const url = ${JSON.stringify(baseUrl)} + '/api/now/table/' + ${JSON.stringify(table)}
                + '?sysparm_query=' + encodeURIComponent(${JSON.stringify(sysparmQuery)})
                + '&sysparm_limit=' + ${sysparmLimit}
                + '&sysparm_fields=' + ${JSON.stringify(sysparmFields)};
            const resp = await fetch(url, {
                method: 'GET',
                credentials: 'include',
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
            return { status: 0, ok: false, error: err && err.message ? err.message : String(err) };
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

        await waitForServiceNowReady(win, Math.floor(timeout / 2));

        const caseQuery = buildQuery(query, ['short_description', 'description']);
        const incQuery = buildQuery(query, ['short_description', 'description']);
        const kbQuery = buildQuery(query, ['short_description', 'text']);

        const [casesRes, incidentsRes, articlesRes] = await Promise.allSettled([
            fetchTable(win, baseUrl, 'sn_customerservice_case', caseQuery, perTable,
                'sys_id,number,short_description,description,state,priority,account,contact,product,assigned_to,assignment_group,opened_by,sys_created_on,sys_updated_on,sys_class_name'),
            fetchTable(win, baseUrl, 'incident', incQuery, perTable,
                'sys_id,number,short_description,description,state,priority,assigned_to,assignment_group,opened_by,caller_id,category,subcategory,sys_created_on,sys_updated_on'),
            fetchTable(win, baseUrl, 'kb_article', kbQuery, perTable,
                'sys_id,number,short_description,text,kb_category,kb_knowledge_base,author,workflow_state,sys_view_count,sys_created_on,sys_updated_on'),
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

        const allAuthFailed = statusCodes.length > 0 && statusCodes.every((code) => code === 401 || code === 403);
        if (allAuthFailed) {
            // The user's role doesn't allow REST API access (common for ESC
            // customer/employee users). Don't error out — return the portal
            // shortcut so the user can still get to their search in one click.
            logger.warn('Phase 3', 'ServiceNow REST API blocked (401/403 on all tables) — returning portal shortcut');
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

module.exports = { searchServiceNow };
