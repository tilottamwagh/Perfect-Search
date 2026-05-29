require('dotenv').config();
const { BrowserWindow, session } = require('electron');
const tokenStore = require('./tokenStore');
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
    const url = process.env.SLACK_WORKSPACE_URL || 'https://app.slack.com';
    const win = openSSOWindow('slack', 'Slack Login', url);

    try {
        const cookies = await waitForCookies({
            source: 'slack',
            domains: ['slack.com', normalizeDomain(url)],
            requiredNames: ['d'],
        });

        const xoxcToken = await extractPageValue(
            win,
            `(function () {
        const boot = window.boot_data || window.__BOOT_DATA__ || {};
        return boot.api_token || boot.token || null;
      })();`
        );

        const slackIdentity = await extractPageValue(
            win,
            `(function () {
        const boot = window.boot_data || window.__BOOT_DATA__ || {};
        return {
          userId: boot.user_id || boot.user?.id || null,
          teamId: boot.team_id || boot.team?.id || null
        };
      })();`,
            {}
        );

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
    const baseUrl = process.env.CONFLUENCE_BASE_URL || 'https://your-org.atlassian.net';
    const win = openSSOWindow('confluence', 'Confluence Login', `${baseUrl}/wiki`);

    try {
        // Atlassian Cloud SSO sets `cloud.session.token` on the unified
        // `.atlassian.com` domain (NOT the tenant `*.atlassian.net`). Match the
        // broader domain set used by the working Atlassian connector so we
        // actually detect the cookie when SSO completes.
        const cookies = await waitForCookies({
            source: 'confluence',
            domains: [
                normalizeDomain(baseUrl),  // ellucian.atlassian.net
                'atlassian.net',
                'atlassian.com',           // ← where cloud.session.token actually lives
                'id.atlassian.com',
            ],
            requiredNames: ['cloud.session.token'],
        });

        return finalizeLogin({
            source: 'confluence',
            win,
            successMessage: 'Confluence SSO login complete',
            tokenData: {
                sessionToken: cookies.find((cookie) => cookie.name === 'cloud.session.token')?.value || null,
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

async function loginServiceNow() {
    logger.info('Phase 2', 'Opening ServiceNow SSO window');
    const baseUrl = process.env.SERVICENOW_BASE_URL || 'https://your-instance.service-now.com';
    const win = openSSOWindow('servicenow', 'ServiceNow Login', baseUrl);

    try {
        const cookies = await waitForCookies({
            source: 'servicenow',
            domains: [normalizeDomain(baseUrl)],
            requiredNames: ['JSESSIONID'],
        });

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
    const baseUrl = process.env.ATLASSIAN_BASE_URL || 'https://home.atlassian.com';
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
    const baseUrl = process.env.BOX_BASE_URL || 'https://ellucian.app.box.com';
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
    const baseUrl = process.env.JIRA_BASE_URL || 'https://ellucian.atlassian.net';
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
    const baseUrl = process.env.RESOURCES_BASE_URL || 'https://resources.elluciancloud.com';
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
    reauth,
    getPersistentWindow,
    clearPersistentWindow,
};
