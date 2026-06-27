require('dotenv').config();
const { BrowserWindow, session } = require('electron');
const tokenStore = require('./tokenStore');
const sourceDefaults = require('../shared/sourceDefaults.json');
const logger = require('../utils/logger');

function getPartition(source) {
    return `persist:perfectsearch-${source}`;
}

function normalizeDomain(urlString) {
    try {
        return new URL(urlString).hostname;
    } catch (_error) {
        return urlString.replace(/^https?:\/\//, '').split('/')[0];
    }
}

function cookieMatches(cookie, domains) {
    return domains.some((domain) => {
        const cookieDomain = cookie.domain.replace(/^\./, '');
        return cookieDomain === domain || domain.endsWith(cookieDomain);
    });
}

function openSSOWindow(source, title, url) {
    const win = new BrowserWindow({
        width: 1000,
        height: 760,
        title,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: getPartition(source),
        },
    });

    win.loadURL(url);
    return win;
}

async function waitForCookies({ source, domains, requiredNames, timeoutMs = 120000 }) {
    const sess = session.fromPartition(getPartition(source));
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        const poller = setInterval(async () => {
            try {
                const cookies = await sess.cookies.get({});
                const matching = cookies.filter((cookie) => cookieMatches(cookie, domains));
                const found = requiredNames.every((name) => matching.some((cookie) => cookie.name === name));

                if (found) {
                    clearInterval(poller);
                    resolve(matching);
                    return;
                }

                if (Date.now() - startedAt > timeoutMs) {
                    clearInterval(poller);
                    // Dump diagnostic info so we can see WHY the wait failed —
                    // which cookies were captured, on which domains. Hugely
                    // useful when an IdP changes cookie names.
                    const observed = cookies
                        .filter((c) => domains.some((d) => c.domain.replace(/^\./, '').endsWith(d.split('.').slice(-2).join('.'))))
                        .map((c) => `${c.name}@${c.domain}`)
                        .slice(0, 30)
                        .join(', ');
                    logger.warn('Phase 2', `[${source}] SSO timeout. required=[${requiredNames.join(', ')}] observed cookies on matching/related domains: ${observed || '(none)'}`);
                    reject(new Error(`SSO timeout waiting for cookies for ${source}`));
                }
            } catch (error) {
                clearInterval(poller);
                reject(error);
            }
        }, 1500);
    });
}

async function extractPageValue(win, script, fallback = null) {
    try {
        return await win.webContents.executeJavaScript(script, true);
    } catch (_error) {
        return fallback;
    }
}

function cookieHeaderFrom(cookies) {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

// Decode the `exp` (epoch seconds → ms) from a JWT cookie value like
// Atlassian's cloud.session.token. Returns null if it isn't a decodable JWT.
function jwtExpiryMs(value) {
    try {
        const parts = String(value).split('.');
        if (parts.length < 2) return null;
        const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return payload && payload.exp ? payload.exp * 1000 : null;
    } catch (_) {
        return null;
    }
}

// Some providers (notably Ellucian's ServiceNow) bind a session token to the
// specific BrowserWindow that created it. Opening a *different* window in the
// same partition — even with identical cookies — gets redirected straight to
// session_timeout.do. For those providers we keep the SSO window alive
// (hidden) so the connector can run its API calls in the same window the user
// authenticated in.
const persistentWindows = {};

function getPersistentWindow(source) {
    const w = persistentWindows[source];
    return (w && !w.isDestroyed()) ? w : null;
}

function clearPersistentWindow(source) {
    const w = persistentWindows[source];
    if (w && !w.isDestroyed()) {
        w.close();
    }
    delete persistentWindows[source];
}

async function finalizeLogin({ source, tokenData, win, successMessage, keepAlive }) {
    tokenStore.save(source, tokenData);
    if (keepAlive) {
        // Hide rather than close — we'll reuse this window for in-page REST calls.
        win.hide();
        // If a previous persistent window exists, close it before replacing.
        if (persistentWindows[source] && persistentWindows[source] !== win && !persistentWindows[source].isDestroyed()) {
            persistentWindows[source].close();
        }
        persistentWindows[source] = win;
        win.on('closed', () => {
            if (persistentWindows[source] === win) {
                delete persistentWindows[source];
            }
        });
    } else if (!win.isDestroyed()) {
        win.close();
    }
    logger.success('Phase 2', successMessage);
    return tokenData;
}

async function loginSlack() {
    logger.info('Phase 2', 'Opening Slack SSO window');
    // Priority: user-saved Settings URL > env var > slack.com default. For
    // Enterprise Grid customers the workspace URL is e.g.
    // https://yourorg.enterprise.slack.com.
    const url = tokenStore.getSourceUrl('slack') || process.env.SLACK_WORKSPACE_URL || sourceDefaults.slack?.baseUrl || 'https://app.slack.com';
    const win = openSSOWindow('slack', 'Slack Login', url);

    try {
        const cookies = await waitForCookies({
            source: 'slack',
            domains: ['slack.com', normalizeDomain(url)],
            requiredNames: ['d'],
        });

        // ── CRITICAL packaged-app fix ────────────────────────────────────────
        // When the user is ALREADY logged into the Slack partition (session
        // from a previous login), the `d` cookie exists immediately and
        // `waitForCookies` returns at once — before the SPA has had a chance
        // to navigate to /client/{TEAMID}/...
        //
        // In dev mode this is fine because webpack-dev-server keeps things
        // fast. In the packaged app (asar overhead, cold start) the SPA takes
        // 3–6 extra seconds to mount, so the 30-second poll below often
        // completes before Slack navigates to the workspace URL, leaving
        // slackTeamId=null in the saved token.
        //
        // Fix: explicitly (re-)navigate to app.slack.com right after cookies
        // are confirmed present. This forces Slack's SPA to boot fresh and
        // reliably redirects to /client/{TEAMID}/... within ~2-4 seconds.
        // It's a no-op when the window is already on the workspace page.
        // Update window title to guide the user — the default Slack page title
        // "Where work happens | Slack" doesn't tell them what to do. Inject a
        // visible title bar hint so they know to click the workspace name (not
        // the "LAUNCH SLACK" button which opens the desktop app instead of
        // navigating our SSO window).
        try {
            win.setTitle('Slack Login — Click your workspace name to connect');
        } catch (_) {}

        try {
            const currentUrl = win.webContents.getURL();
            if (!currentUrl.includes('/client/')) {
                logger.info('Phase 2', 'Navigating Slack window to app.slack.com to force /client/{TEAMID}/ redirect');
                win.loadURL('https://app.slack.com');
            }
        } catch (_) { /* ignore if window is mid-navigation */ }

        const xoxcToken = await extractPageValue(
            win,
            `(function () {
        const boot = window.boot_data || window.__BOOT_DATA__ || {};
        return boot.api_token || boot.token || null;
      })();`
        );

        // The team ID can only be captured AFTER Slack's SPA finishes loading
        // and navigates to /client/{TEAM}/... — but the `d` cookie arrives
        // much earlier (during the SAML round-trip). Poll for up to 45s
        // (extended from 30s for packaged-app cold-start), re-running the
        // extraction every 1s until we find a team ID or time out.
        const extractScript = `(function () {
      try {
        // 1. URL path — most reliable once workspace is loaded
        var urlMatch = (location.pathname || '').match(/\\/client\\/([A-Z0-9]+)/);
        var teamFromUrl = urlMatch ? urlMatch[1] : null;

        // 2. Modern TS.boot_data / legacy globals
        var tsBoot = (window.TS && window.TS.boot_data) || {};
        var legacy = window.boot_data || window.__BOOT_DATA__ || {};

        // 3. localStorage localConfig_v2
        var lcTeamId = null, lcUserId = null;
        try {
          var raw = localStorage.getItem('localConfig_v2');
          if (raw) {
            var parsed = JSON.parse(raw);
            var teams = parsed && parsed.teams ? parsed.teams : null;
            if (teams) {
              var ids = Object.keys(teams);
              if (ids.length > 0) {
                lcTeamId = ids[0];
                lcUserId = teams[ids[0]].user_id || null;
              }
            }
          }
        } catch (_) {}

        // 4. Workspace selector DOM — when the user is on the "Welcome back"
        //    picker (multiple workspaces shown), Slack renders anchor tags
        //    with href="/client/{TEAMID}/..." for each workspace tile. We
        //    can read the team ID from those links without waiting for the
        //    user to click, so we can auto-navigate to the right workspace.
        var teamFromDom = null;
        try {
          var anchors = Array.from(document.querySelectorAll('a'));
          for (var i = 0; i < anchors.length; i++) {
            var href = anchors[i].getAttribute('href') || anchors[i].href || '';
            var dm = href.match(/\\/client\\/([A-Z0-9]+)/) ||
                     href.match(/[?&]team=([A-Z0-9]+)/);
            if (dm && dm[1]) { teamFromDom = dm[1]; break; }
          }
          // Also check data-team-id / data-workspace-id attributes
          if (!teamFromDom) {
            var el = document.querySelector('[data-team-id],[data-workspace-id],[data-team]');
            if (el) teamFromDom = el.dataset.teamId || el.dataset.workspaceId || el.dataset.team || null;
          }
          // If found in DOM but user hasn't navigated yet, auto-navigate
          if (teamFromDom && !teamFromUrl) {
            var targetUrl = 'https://app.slack.com/client/' + teamFromDom;
            if (location.href.indexOf('/client/') === -1) {
              location.href = targetUrl;
            }
          }
        } catch (_) {}

        return {
          teamId: teamFromUrl || tsBoot.team_id || (tsBoot.team && tsBoot.team.id) || legacy.team_id || (legacy.team && legacy.team.id) || lcTeamId || teamFromDom || null,
          userId: tsBoot.user_id || (tsBoot.user && tsBoot.user.id) || legacy.user_id || (legacy.user && legacy.user.id) || lcUserId || null,
          href: location.href,
        };
      } catch (e) { return { teamId: null, userId: null, error: String(e) }; }
    })();`;

        const slackIdentity = await new Promise((resolve) => {
            const startedAt = Date.now();
            const tick = async () => {
                try {
                    const info = await extractPageValue(win, extractScript, { teamId: null, userId: null });
                    if (info && info.teamId) {
                        resolve(info);
                        return;
                    }
                    if (Date.now() - startedAt > 45000) {
                        resolve(info || { teamId: null, userId: null });
                        return;
                    }
                    setTimeout(tick, 1000);
                } catch (_) {
                    setTimeout(tick, 1000);
                }
            };
            tick();
        });

        if (!slackIdentity?.teamId) {
            logger.warn('Phase 2', `Slack team ID could not be extracted after 30s (last URL: ${slackIdentity?.href || 'unknown'}). Search will fail until user re-logs in.`);
        } else {
            logger.info('Phase 2', `Slack team ID captured: ${slackIdentity.teamId}`);
        }

        return finalizeLogin({
            source: 'slack',
            win,
            successMessage: 'Slack SSO login complete',
            tokenData: {
                dCookie: cookies.find((cookie) => cookie.name === 'd')?.value || null,
                bCookie: cookies.find((cookie) => cookie.name === 'b')?.value || null,
                xoxcToken,
                slackUserId: slackIdentity?.userId || null,
                slackTeamId: slackIdentity?.teamId || null,
                allCookies: cookieHeaderFrom(cookies),
                baseUrl: url,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'Slack SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

async function loginConfluence() {
    logger.info('Phase 2', 'Opening Confluence SSO window');
    const baseUrl = tokenStore.getSourceUrl('confluence') || process.env.CONFLUENCE_BASE_URL || sourceDefaults.confluence?.baseUrl || 'https://your-org.atlassian.net';

    // CRITICAL (stale-session fix): a previous login leaves expired
    // cloud.session.token / tenant.session.token cookies in the partition. If
    // we just open the window, `waitForCookies` resolves on those *expired*
    // cookies instantly and we save a dead session that 403s ("Current user
    // not permitted to use Confluence"). Wiping the partition cookies first
    // forces the window through a real SSO that mints fresh cookies.
    const sess = session.fromPartition(getPartition('confluence'));
    try {
        await sess.clearStorageData({ storages: ['cookies'] });
        logger.info('Phase 2', 'Cleared stale Confluence partition cookies before login');
    } catch (err) {
        logger.warn('Phase 2', `Could not clear Confluence cookies: ${err && err.message}`);
    }

    const win = openSSOWindow('confluence', 'Confluence Login', `${baseUrl}/wiki`);

    try {
        // Atlassian Cloud SSO sets `cloud.session.token` on the unified
        // `.atlassian.com` domain (NOT the tenant `*.atlassian.net`). Match the
        // broader domain set used by the working Atlassian connector so we
        // actually detect the cookie when SSO completes.
        const confluenceDomains = [
            normalizeDomain(baseUrl),  // ellucian.atlassian.net
            'atlassian.net',
            'atlassian.com',           // ← where cloud.session.token actually lives
            'id.atlassian.com',
        ];
        await waitForCookies({
            source: 'confluence',
            domains: confluenceDomains,
            requiredNames: ['cloud.session.token'],
        });

        // Wait for BOTH (a) a *fresh* (non-expired) cloud.session.token and
        // (b) the tenant.session.token. cloud.session.token is the org-level
        // session; Confluence's REST API is authorized by the tenant product
        // session cookie, set on *.atlassian.net only once the /wiki product
        // session is established (lags the org cookie). We must not snapshot
        // until both are present and the session is genuinely fresh.
        const captureDeadline = Date.now() + 30000;
        let cookies = [];
        let hasTenant = false;
        let fresh = false;
        do {
            const all = await sess.cookies.get({});
            cookies = all.filter((cookie) => cookieMatches(cookie, confluenceDomains));
            const cloud = cookies.find((cookie) => cookie.name === 'cloud.session.token');
            hasTenant = cookies.some((cookie) => cookie.name === 'tenant.session.token');
            const expMs = cloud ? jwtExpiryMs(cloud.value) : null;
            // Fresh = expiry comfortably in the future. If it isn't a JWT we
            // can't read exp, so fall back to "present".
            fresh = expMs ? expMs > Date.now() + 60000 : Boolean(cloud);
            if (hasTenant && fresh) break;
            await new Promise((r) => setTimeout(r, 1000));
        } while (Date.now() < captureDeadline);

        logger.info('Phase 2', `Confluence cookies captured (tenant=${hasTenant ? 'yes' : 'NO'}, fresh=${fresh}): ${cookies.map((c) => c.name).join(', ')}`);

        // Final gate: probe the REST API in-page before saving. Only a 2xx
        // means the session genuinely works — anything else (esp. 403) means
        // we'd be saving a broken session, so fail with actionable guidance
        // instead of silently degrading to the portal shortcut on every search.
        const probe = await extractPageValue(
            win,
            `(async function () {
                try {
                    const r = await fetch(${JSON.stringify(baseUrl)} + '/wiki/rest/api/search?cql=' + encodeURIComponent('type=page') + '&limit=1', { credentials: 'include', headers: { 'Accept': 'application/json' } });
                    return { status: r.status, ok: r.ok };
                } catch (e) { return { status: 0, error: e && e.message ? e.message : String(e) }; }
            })();`,
            { status: 0 }
        );
        if (!(probe.status >= 200 && probe.status < 300)) {
            logger.warn('Phase 2', `Confluence session probe failed (HTTP ${probe.status}) — not saving a broken session`);
            throw new Error('Confluence sign-in didn\'t establish a working session (the API returned ' + (probe.status || 'no response') + '). Click Connect again and let the window fully load your Confluence home before it closes.');
        }
        logger.success('Phase 2', `Confluence session probe OK (HTTP ${probe.status})`);

        return finalizeLogin({
            source: 'confluence',
            win,
            successMessage: 'Confluence SSO login complete',
            tokenData: {
                sessionToken: cookies.find((cookie) => cookie.name === 'cloud.session.token')?.value || null,
                tenantSession: cookies.find((cookie) => cookie.name === 'tenant.session.token')?.value || null,
                atssession: cookies.find((cookie) => cookie.name === 'atlassian.xsrf.token' || cookie.name === 'ATSSESSION')?.value || null,
                cookieHeader: cookieHeaderFrom(cookies),
                baseUrl,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'Confluence SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

// After ServiceNow cookies appear, the JSESSIONID exists the instant the page
// loads — even before the user has typed credentials — so cookie presence alone
// is NOT proof of an authenticated session. ServiceNow tells the truth in the
// `x-sessionloggedin` response header: `false` means the session is anonymous.
//
// Crucially, an anonymous session is the EXPECTED initial state — the user
// hasn't logged in yet. So we must NOT bail on the first `false`; instead we
// keep the SSO window open and poll the table API from inside it, waiting for
// the session to become authenticated as the user completes login. We only
// give up once `timeoutMs` elapses (login never finished) or the user closes
// the window. While the page is mid-redirect on the IdP (cross-origin), the
// in-page fetch simply fails and we keep waiting.
//
// Returns { loggedIn, status, timedOut?, aborted? } from the last probe.
async function probeServiceNowSession(win, baseUrl, { timeoutMs = 120000, intervalMs = 2500 } = {}) {
    const script = `(async function () {
        try {
            const url = ${JSON.stringify(baseUrl)} + '/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id';
            const resp = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: { 'Accept': 'application/json', 'X-UserToken': window.g_ck || '' },
            });
            return {
                status: resp.status,
                ok: resp.ok,
                // Header is a string 'true'/'false' when present, else null.
                loggedIn: resp.headers.get('x-sessionloggedin'),
                hasGCK: typeof window.g_ck === 'string' && window.g_ck.length > 0,
            };
        } catch (err) {
            return { status: 0, ok: false, error: err && err.message ? err.message : String(err) };
        }
    })();`;

    const startedAt = Date.now();
    let last = { status: 0, ok: false, loggedIn: null };
    while (Date.now() - startedAt < timeoutMs) {
        // User closed the login window — abort cleanly.
        if (win.isDestroyed()) {
            return { loggedIn: false, status: 0, aborted: true };
        }
        last = await extractPageValue(win, script, { status: 0, ok: false, loggedIn: null });
        // Authenticated: API accepted us AND ServiceNow didn't flag the session
        // as anonymous. (Some endpoints omit the header on success, so treat
        // "ok and not explicitly false" as logged in.)
        if (last.ok && last.loggedIn !== 'false') {
            return { loggedIn: true, status: last.status };
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { loggedIn: false, status: last.status, timedOut: true };
}

async function loginServiceNow() {
    logger.info('Phase 2', 'Opening ServiceNow SSO window');
    // Priority: user-saved Settings URL > env var > placeholder. The packaged
    // installer has no .env, so the Settings entry is the real source of
    // truth for end users.
    const userUrl = tokenStore.getSourceUrl('servicenow');
    const baseUrl = userUrl || process.env.SERVICENOW_BASE_URL || 'https://your-instance.service-now.com';
    if (!userUrl && !process.env.SERVICENOW_BASE_URL) {
        throw new Error('ServiceNow instance URL not configured. Open Settings → ServiceNow URL and enter your instance (e.g. https://yourcompany.service-now.com).');
    }
    const win = openSSOWindow('servicenow', 'ServiceNow Login', baseUrl);

    try {
        // First wait for JSESSIONID — this only confirms the ServiceNow page
        // loaded; the session is still anonymous until the user logs in.
        await waitForCookies({
            source: 'servicenow',
            domains: [normalizeDomain(baseUrl)],
            requiredNames: ['JSESSIONID'],
        });

        // Keep the window open and wait for the user to actually complete login.
        // The probe polls the API until the session reports authenticated, so we
        // never save an anonymous session (which would silently 401 on every
        // later search). Distinct messages tell the user what to do next.
        const probe = await probeServiceNowSession(win, baseUrl);
        if (!probe.loggedIn) {
            if (probe.aborted) {
                logger.warn('Phase 2', 'ServiceNow login window was closed before sign-in finished');
                throw new Error('ServiceNow login was cancelled — the window closed before sign-in finished. Click Connect again and sign in fully; the window stays open and closes itself once login completes.');
            }
            logger.warn('Phase 2', `ServiceNow session still anonymous after timeout (last status=${probe.status}) — not saving token`);
            throw new Error('ServiceNow sign-in did not complete in time. Click Connect again and complete your single sign-on (including any MFA) — the window stays open and closes itself automatically once you reach the ServiceNow home screen.');
        }
        logger.success('Phase 2', 'ServiceNow session probe confirmed authenticated');

        // Re-read cookies NOW (post-login) — the ones captured above were the
        // pre-login anonymous set. Pull the csrf/g_ck token too, which only
        // exists once the authenticated page has rendered.
        const sess = session.fromPartition(getPartition('servicenow'));
        const allCookies = await sess.cookies.get({});
        const cookies = allCookies.filter((cookie) => cookieMatches(cookie, [normalizeDomain(baseUrl)]));
        const csrfToken = await extractPageValue(
            win,
            `(function () {
        return window.g_ck || document.querySelector('meta[name="x-usertoken"]')?.content || null;
      })();`
        );

        return finalizeLogin({
            source: 'servicenow',
            win,
            keepAlive: true,
            successMessage: 'ServiceNow SSO login complete',
            tokenData: {
                jsessionid: cookies.find((cookie) => cookie.name === 'JSESSIONID')?.value || null,
                ck: cookies.find((cookie) => cookie.name === 'glide_session_store' || cookie.name === 'ck')?.value || csrfToken,
                csrfToken,
                cookieHeader: cookieHeaderFrom(cookies),
                baseUrl,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'ServiceNow SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

// Atlassian unified portal — home.atlassian.com after login lands at
//   https://home.atlassian.com/o/{orgId}/?cloudId={cloudId}
// We need both IDs to construct search URLs, so we extract them from the
// final landing URL after SSO completes.
async function loginAtlassian() {
    logger.info('Phase 2', 'Opening Atlassian SSO window');
    const baseUrl = tokenStore.getSourceUrl('atlassian') || process.env.ATLASSIAN_BASE_URL || sourceDefaults.atlassian?.baseUrl || 'https://home.atlassian.com';
    const win = openSSOWindow('atlassian', 'Atlassian Login', baseUrl);

    try {
        const cookies = await waitForCookies({
            source: 'atlassian',
            domains: ['home.atlassian.com', 'atlassian.com', 'id.atlassian.com'],
            requiredNames: ['cloud.session.token'],
        });

        // Once cookies are present, give the SPA a moment to land on the post-
        // login URL, then read the org/cloud IDs from window.location.
        const landed = await new Promise((resolve) => {
            const startedAt = Date.now();
            const poller = setInterval(async () => {
                try {
                    const info = await extractPageValue(
                        win,
                        `(function () {
                            const m = window.location.href.match(/\\/o\\/([0-9a-f-]+)/i);
                            const c = window.location.search.match(/[?&]cloudId=([0-9a-f-]+)/i);
                            return {
                                href: window.location.href,
                                orgId: m ? m[1] : null,
                                cloudId: c ? c[1] : null,
                            };
                        })();`,
                        {}
                    );
                    if (info && info.orgId && info.cloudId) {
                        clearInterval(poller);
                        resolve(info);
                        return;
                    }
                    if (Date.now() - startedAt > 30000) {
                        clearInterval(poller);
                        resolve(info || {});
                    }
                } catch (_) {
                    // keep polling
                }
            }, 1000);
        });

        return finalizeLogin({
            source: 'atlassian',
            win,
            successMessage: `Atlassian SSO login complete (org=${landed.orgId || '?'} cloud=${landed.cloudId || '?'})`,
            tokenData: {
                sessionToken: cookies.find((cookie) => cookie.name === 'cloud.session.token')?.value || null,
                orgId: landed.orgId || null,
                cloudId: landed.cloudId || null,
                landingUrl: landed.href || null,
                cookieHeader: cookieHeaderFrom(cookies),
                baseUrl,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'Atlassian SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

// Box's login URL redirects through SAML/Okta then lands back at
// ellucian.app.box.com. We don't need API access — the portal shortcut
// only opens a URL externally — so we just wait for the SSO chain to land
// on box.com and stabilize there.
async function waitForUrlOnDomain(win, targetDomain, requiredStableSeconds = 5, timeoutMs = 120000) {
    const startedAt = Date.now();
    let stableSince = null;
    return new Promise((resolve, reject) => {
        const poller = setInterval(async () => {
            try {
                const href = await extractPageValue(win, `window.location.href`, '');
                let host = '';
                try { host = new URL(href).host; } catch (_) {}
                if (host && host.endsWith(targetDomain)) {
                    if (stableSince === null) stableSince = Date.now();
                    if (Date.now() - stableSince >= requiredStableSeconds * 1000) {
                        clearInterval(poller);
                        resolve(href);
                        return;
                    }
                } else {
                    stableSince = null;
                }
                if (Date.now() - startedAt > timeoutMs) {
                    clearInterval(poller);
                    reject(new Error(`Timeout waiting for landing on ${targetDomain}`));
                }
            } catch (_) {
                // page may be mid-navigation; keep polling
            }
        }, 1500);
    });
}

async function loginBox() {
    logger.info('Phase 2', 'Opening Box SSO window');
    const baseUrl = tokenStore.getSourceUrl('box') || process.env.BOX_BASE_URL || sourceDefaults.box?.baseUrl || 'https://ellucian.app.box.com';
    const win = openSSOWindow('box', 'Box Login', `${baseUrl}/folder/0`);

    try {
        // After SAML/Okta SSO completes, the user lands on app.box.com.
        // Wait for the URL to be stable on that domain (5s of no redirects).
        const landingUrl = await waitForUrlOnDomain(win, 'app.box.com', 5);

        // Capture any cookies set on box.com so we can use them later if we
        // want to call Box's API — but the portal shortcut doesn't require them.
        const sess = session.fromPartition(getPartition('box'));
        const cookies = await sess.cookies.get({});
        const boxCookies = cookies.filter((c) => c.domain && c.domain.replace(/^\./, '').endsWith('box.com'));

        return finalizeLogin({
            source: 'box',
            win,
            successMessage: `Box SSO login complete (landed on ${landingUrl})`,
            tokenData: {
                landingUrl,
                cookieHeader: cookieHeaderFrom(boxCookies),
                baseUrl,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'Box SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

// Jira uses the same Atlassian SSO as Confluence — same `cloud.session.token`
// cookie on the unified atlassian.com domain.
async function loginJira() {
    logger.info('Phase 2', 'Opening Jira SSO window');
    const baseUrl = tokenStore.getSourceUrl('jira') || process.env.JIRA_BASE_URL || sourceDefaults.jira?.baseUrl || 'https://ellucian.atlassian.net';
    const url = `${baseUrl}/jira/projects?page=1&sortKey=name&sortOrder=ASC`;
    const win = openSSOWindow('jira', 'Jira Login', url);

    try {
        const cookies = await waitForCookies({
            source: 'jira',
            domains: [
                normalizeDomain(baseUrl),
                'atlassian.net',
                'atlassian.com',
                'id.atlassian.com',
            ],
            requiredNames: ['cloud.session.token'],
        });

        return finalizeLogin({
            source: 'jira',
            win,
            successMessage: 'Jira SSO login complete',
            tokenData: {
                sessionToken: cookies.find((c) => c.name === 'cloud.session.token')?.value || null,
                cookieHeader: cookieHeaderFrom(cookies),
                baseUrl,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'Jira SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

// Ellucian Resources — the portal at resources.elluciancloud.com. SSO
// (typically Okta) redirects the user away to authenticate and then back to
// the portal home. We reuse the Box-style "URL settles on the target domain"
// detection because Ellucian's auth chain can use multiple intermediate
// cookies and the only reliable "you are signed in" signal is "the URL bar
// stops moving and is on resources.elluciancloud.com".
async function loginResources() {
    logger.info('Phase 2', 'Opening Ellucian Resources SSO window');
    const baseUrl = tokenStore.getSourceUrl('resources') || process.env.RESOURCES_BASE_URL || sourceDefaults.resources?.baseUrl || 'https://resources.elluciancloud.com';
    const win = openSSOWindow('resources', 'Ellucian Resources Login', `${baseUrl}/home`);

    try {
        const landingUrl = await waitForUrlOnDomain(win, 'elluciancloud.com', 5);

        const sess = session.fromPartition(getPartition('resources'));
        const cookies = await sess.cookies.get({});
        const portalCookies = cookies.filter((c) => c.domain && c.domain.replace(/^\./, '').endsWith('elluciancloud.com'));

        return finalizeLogin({
            source: 'resources',
            win,
            successMessage: `Ellucian Resources SSO login complete (landed on ${landingUrl})`,
            tokenData: {
                landingUrl,
                cookieHeader: cookieHeaderFrom(portalCookies),
                baseUrl,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'Ellucian Resources SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

// Datadog — SaaS observability. SSO (Okta/SAML/Google) lands the user back
// on app.datadoghq.com (or their regional host). Same "URL settles on the
// target domain" detection used by Box/Resources/Jira.
async function loginDatadog() {
    logger.info('Phase 2', 'Opening Datadog SSO window');
    const baseUrl = tokenStore.getSourceUrl('datadog') || process.env.DATADOG_BASE_URL || sourceDefaults.datadog?.baseUrl || 'https://app.datadoghq.com';
    const win = openSSOWindow('datadog', 'Datadog Login', baseUrl);

    try {
        // Datadog's host varies by region (datadoghq.com / datadoghq.eu /
        // us3.datadoghq.com). Match the registered suffix "datadoghq".
        const landingUrl = await waitForUrlOnDomain(win, 'datadoghq', 5);

        const sess = session.fromPartition(getPartition('datadog'));
        const cookies = await sess.cookies.get({});
        const portalCookies = cookies.filter((c) => c.domain && /datadoghq/.test(c.domain));

        return finalizeLogin({
            source: 'datadog',
            win,
            successMessage: `Datadog SSO login complete (landed on ${landingUrl})`,
            tokenData: {
                landingUrl,
                cookieHeader: cookieHeaderFrom(portalCookies),
                baseUrl,
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'Datadog SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

// AWS — IAM Identity Center (formerly SSO). Each org has a unique start URL
// like https://d-XXXXXXXX.awsapps.com/start/. After login the user picks a
// permission set and lands on a *.console.aws.amazon.com console page.
// We accept either the SSO host or the console host as the "you're in" signal.
async function loginAws() {
    logger.info('Phase 2', 'Opening AWS SSO window');
    const baseUrl = tokenStore.getSourceUrl('aws') || process.env.AWS_SSO_START_URL || sourceDefaults.aws?.baseUrl;
    if (!baseUrl) {
        throw new Error('AWS SSO start URL not configured. Open Settings → AWS SSO start URL and enter your IAM Identity Center URL (e.g. https://d-9067bdf2d6.awsapps.com/start/).');
    }
    const win = openSSOWindow('aws', 'AWS Login', baseUrl);

    try {
        // The console.aws.amazon.com landing is the most reliable "fully
        // authenticated" marker, but the user may stay on the start page if
        // they only need IAM Identity Center session cookies. Accept either.
        const landingUrl = await waitForUrlOnDomain(win, 'aws.amazon.com', 5)
            .catch(() => waitForUrlOnDomain(win, 'awsapps.com', 5));

        const sess = session.fromPartition(getPartition('aws'));
        const cookies = await sess.cookies.get({});
        const portalCookies = cookies.filter((c) =>
            c.domain && (/aws\.amazon\.com$/.test(c.domain) || /awsapps\.com$/.test(c.domain))
        );

        return finalizeLogin({
            source: 'aws',
            win,
            successMessage: `AWS SSO login complete (landed on ${landingUrl})`,
            tokenData: {
                landingUrl,
                cookieHeader: cookieHeaderFrom(portalCookies),
                baseUrl,
                region: tokenStore.getSourceConfig('aws')?.region || 'us-east-1',
            },
        });
    } catch (error) {
        logger.error('Phase 2', 'AWS SSO failed', error);
        if (!win.isDestroyed()) {
            win.close();
        }
        throw error;
    }
}

async function reauth(source) {
    tokenStore.clear(source);
    switch (source) {
        case 'slack':
            return loginSlack();
        case 'confluence':
            return loginConfluence();
        case 'servicenow':
            return loginServiceNow();
        case 'atlassian':
            return loginAtlassian();
        case 'box':
            return loginBox();
        case 'jira':
            return loginJira();
        case 'resources':
            return loginResources();
        case 'datadog':
            return loginDatadog();
        case 'aws':
            return loginAws();
        default:
            throw new Error(`Unknown source: ${source}`);
    }
}

module.exports = {
    loginSlack,
    loginConfluence,
    loginServiceNow,
    loginAtlassian,
    loginBox,
    loginJira,
    loginResources,
    loginDatadog,
    loginAws,
    reauth,
    getPersistentWindow,
    clearPersistentWindow,
};
