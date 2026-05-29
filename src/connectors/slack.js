require('dotenv').config();
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const tokenStore = require('../auth/tokenStore');
const logger = require('../utils/logger');

const SLACK_PARTITION = 'persist:perfectsearch-slack';

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createHiddenSlackWindow(url) {
    const win = new BrowserWindow({
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: SLACK_PARTITION,
        },
    });

    await win.loadURL(url);
    return win;
}

async function waitForSlackReady(win, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const state = await win.webContents.executeJavaScript(
            `(function () {
                try {
                    var ready = document.readyState === 'complete';
                    var bodyText = document.body ? document.body.innerText : '';
                    var isAuthPage = bodyText.indexOf('Sign in') !== -1
                        && bodyText.indexOf('enter your workspace') !== -1;
                    return {
                        ready: ready,
                        isAuthPage: isAuthPage,
                        url: window.location.href,
                    };
                } catch (e) {
                    return { ready: false, isAuthPage: false, url: '', error: e.message };
                }
            })();`,
            true
        );

        if (state.isAuthPage) {
            throw new Error('AUTH_EXPIRED');
        }

        if (state.ready) {
            return state;
        }

        await wait(1000);
    }

    throw new Error('Slack page did not load in time — session may be expired');
}

async function extractApiToken(win) {
    return win.webContents.executeJavaScript(
        `(function () {
            try {
                // Strategy 1: boot_data.api_token (classic)
                var boot = window.boot_data || window.__BOOT_DATA__ || {};
                if (typeof boot.api_token === 'string' && boot.api_token.length > 10) {
                    return { source: 'boot_data', token: boot.api_token };
                }

                // Strategy 2: localStorage (Slack stores token in localConfig_v2)
                try {
                    var cfgRaw = localStorage.getItem('localConfig_v2');
                    if (cfgRaw) {
                        var cfg = JSON.parse(cfgRaw);
                        var teams = cfg.teams || {};
                        var teamIds = Object.keys(teams);
                        for (var ti = 0; ti < teamIds.length; ti++) {
                            var t = teams[teamIds[ti]];
                            if (t && t.token && typeof t.token === 'string' && t.token.length > 10) {
                                return { source: 'localConfig_v2.' + teamIds[ti], token: t.token };
                            }
                        }
                    }
                } catch (lsErr) {
                    // ignore
                }

                // Strategy 3: Look for xoxc- or xoxs- tokens in localStorage
                try {
                    for (var i = 0; i < localStorage.length; i++) {
                        var key = localStorage.key(i);
                        var val = localStorage.getItem(key);
                        if (val && typeof val === 'string' && val.indexOf('xoxc-') === 0) {
                            return { source: 'localStorage.' + key, token: val };
                        }
                        if (val && typeof val === 'string' && val.indexOf('xoxs-') === 0) {
                            return { source: 'localStorage.' + key, token: val };
                        }
                    }
                } catch (lsErr2) {
                    // ignore
                }

                return { source: 'none', token: null };
            } catch (e) {
                return { source: 'error', token: null, error: e.message };
            }
        })();`,
        true
    );
}

// Slack's /api/search.all caps `count` at 100 per call. To return more than
// 100 results per module we have to paginate using the `page` parameter and
// merge the pages ourselves. Pagination stops when:
//   - we have at least `targetCount` items, OR
//   - the API reports we've reached the last page, OR
//   - we hit `maxPages` (a safety cap so a bad query can't loop forever).
async function fetchSlackModule(win, token, query, module, targetCount) {
    const maxPages = 12;          // 12 pages * 100 = 1200 max per module
    const perPage = 100;          // Slack's hard cap

    const script = `(async function () {
        try {
            var token = ${JSON.stringify(token)};
            if (!token) {
                return { error: 'NO_TOKEN', message: 'No API token provided' };
            }

            var target = ${targetCount};
            var maxPages = ${maxPages};
            var perPage = ${perPage};
            var moduleName = ${JSON.stringify(module)};

            var merged = null;             // accumulated module payload
            var paginationLast = null;
            var pagesFetched = 0;

            for (var page = 1; page <= maxPages; page++) {
                var params = new URLSearchParams();
                params.append('token', token);
                params.append('module', moduleName);
                params.append('query', ${JSON.stringify(query)});
                params.append('count', String(perPage));
                params.append('page', String(page));
                params.append('sort', 'score');
                params.append('sort_dir', 'desc');

                var resp = await fetch('/api/search.all', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params.toString(),
                });
                var raw = await resp.text();
                var data;
                try {
                    data = JSON.parse(raw);
                } catch (parseErr) {
                    return { error: 'PARSE_ERROR', raw: raw.substring(0, 800), status: resp.status };
                }
                if (!data.ok) {
                    if (merged) break;
                    return { ok: false, status: resp.status, data: data };
                }

                pagesFetched++;
                var moduleData = data[moduleName === 'messages' ? 'messages' : 'files'];
                if (!moduleData || !Array.isArray(moduleData.matches)) {
                    if (!merged) merged = data;
                    break;
                }

                if (!merged) {
                    merged = data;
                } else {
                    // Append matches into the accumulator
                    var bucket = merged[moduleName === 'messages' ? 'messages' : 'files'];
                    bucket.matches = bucket.matches.concat(moduleData.matches);
                }

                var bucket2 = merged[moduleName === 'messages' ? 'messages' : 'files'];
                paginationLast = moduleData.pagination || null;
                var totalAvailable = (moduleData.total != null) ? moduleData.total : (paginationLast && paginationLast.total_count) || 0;

                if (bucket2.matches.length >= target) break;
                if (moduleData.matches.length < perPage) break;       // last page already
                if (totalAvailable && bucket2.matches.length >= totalAvailable) break;
            }

            return {
                ok: true,
                status: 200,
                pagesFetched: pagesFetched,
                data: merged,
            };
        } catch (fetchErr) {
            return { error: 'FETCH_ERROR', message: fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr) };
        }
    })();`;

    return win.webContents.executeJavaScript(script, true);
}

// Slack's search API returns permalinks on the workspace's *short* subdomain
// (e.g. `ellucian.slack.com`), but SSO auth cookies live on the *enterprise*
// subdomain (`ellucian.enterprise.slack.com`). Loading the short-subdomain URL
// in the webview hits an unauthenticated host, which Slack server-redirects —
// and the webview aborts the navigation with ERR_ABORTED.
// Solution: rewrite every permalink to use the same host we authenticated on.
function rewriteSlackHost(permalink, authBaseUrl) {
    if (!permalink || !authBaseUrl) return permalink;
    try {
        const authHost = new URL(authBaseUrl).host;
        return permalink.replace(/^https?:\/\/[^/]+/, 'https://' + authHost);
    } catch (_) {
        return permalink;
    }
}

function mapMessageResults(messages, teamId, authBaseUrl) {
    const items = [];

    if (!messages || !Array.isArray(messages.matches)) {
        return items;
    }

    for (const match of messages.matches) {
        const channelName = (match.channel && match.channel.name) || null;
        const channelId = (match.channel && match.channel.id) || null;
        const text = (match.text || match.plain_text || '').replace(/\s+/g, ' ').trim();

        if (!text || text.length < 5) {
            continue;
        }

        // Use Slack's canonical permalink rewritten to the auth host so cookies
        // match. See note above rewriteSlackHost for the underlying issue.
        let permalink = match.permalink || '';
        if (!permalink && channelId && match.ts) {
            const tsParts = match.ts.split('.');
            const tsShort = tsParts.length === 2 ? tsParts[0] + tsParts[1] : match.ts.replace('.', '');
            permalink = 'https://app.slack.com/client/' + teamId + '/' + channelId + '/p' + tsShort;
        }
        permalink = rewriteSlackHost(permalink, authBaseUrl);

        // Pull richer fields from the Slack search.all message payload.
        const author = match.username || match.user_name || (match.user_profile && match.user_profile.real_name) || null;
        const userId = match.user || null;
        const reactionsList = Array.isArray(match.reactions)
            ? match.reactions.map((r) => `:${r.name}: ×${r.count}`).join('  ')
            : null;
        const replyCount = (match.reply_count != null) ? match.reply_count
            : (match.reply_users_count != null ? match.reply_users_count : null);
        const isThread = !!match.thread_ts;
        const attachmentsCount = Array.isArray(match.attachments) ? match.attachments.length : 0;
        const filesCount = Array.isArray(match.files) ? match.files.length : 0;

        items.push({
            id: 'slack-msg-' + (match.iid || match.ts || Math.random().toString(36).slice(2)),
            source: 'Slack',
            type: 'Message',
            title: text.substring(0, 80) || 'Slack message',
            snippet: text.substring(0, 300),
            link: permalink,
            channel: channelName,
            author,
            date: match.ts ? new Date(parseFloat(match.ts) * 1000).toISOString() : null,
            score: 85,
            extras: {
                'Channel ID': channelId,
                'User ID': userId,
                'Team ID': teamId,
                'Message TS': match.ts,
                'Thread TS': match.thread_ts || null,
                'Thread': isThread ? `Reply in thread` : (replyCount ? `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : null),
                'Reactions': reactionsList,
                'Attachments': attachmentsCount ? `${attachmentsCount}` : null,
                'Files': filesCount ? `${filesCount}` : null,
                'Full text length': text.length > 300 ? `${text.length} chars (snippet truncated)` : null,
            },
        });
    }

    return items;
}

function mapFileResults(files, teamId, authBaseUrl) {
    const items = [];

    if (!files || !Array.isArray(files.matches)) {
        return items;
    }

    for (const match of files.matches) {
        const fileName = match.name || match.title || 'Unnamed file';
        const fileType = (match.filetype || match.pretty_type || 'File').toUpperCase();
        const channelName = (match.channel && match.channel.name) || null;
        const channelId = (match.channel && match.channel.id) || null;

        // Use canonical permalink rewritten to auth host — see mapMessageResults.
        let permalink = match.permalink || '';
        if (!permalink && channelId && match.ts) {
            const tsParts = match.ts.split('.');
            const tsShort = tsParts.length === 2 ? tsParts[0] + tsParts[1] : match.ts.replace('.', '');
            permalink = 'https://app.slack.com/client/' + teamId + '/' + channelId + '/p' + tsShort;
        }
        permalink = rewriteSlackHost(permalink, authBaseUrl);

        // Build a snippet from the file match
        let snippet = '';
        if (match.plain_text) {
            snippet = match.plain_text.replace(/\s+/g, ' ').trim().substring(0, 300);
        } else if (match.text) {
            snippet = match.text.replace(/\s+/g, ' ').trim().substring(0, 300);
        } else if (match.title) {
            snippet = match.title + ' (' + fileType + ')';
        }

        const sizeBytes = match.size != null ? Number(match.size) : null;
        const sizeKb = sizeBytes != null ? Math.round(sizeBytes / 1024) : null;
        const author = match.username || (match.user_profile && match.user_profile.real_name) || null;
        const commentsCount = match.comments_count != null ? match.comments_count : null;
        const sharedIn = Array.isArray(match.channels) ? match.channels.length : 0;

        items.push({
            id: 'slack-file-' + (match.id || match.ts || Math.random().toString(36).slice(2)),
            source: 'Slack',
            type: fileType,
            title: fileName.substring(0, 80),
            snippet: snippet,
            link: permalink,
            channel: channelName,
            author,
            date: match.timestamp ? new Date(match.timestamp * 1000).toISOString()
                : (match.ts ? new Date(parseFloat(match.ts) * 1000).toISOString() : null),
            score: 75,
            extras: {
                'Filename': fileName,
                'File type': match.pretty_type || match.filetype || null,
                'MIME type': match.mimetype || null,
                'Size': sizeKb != null ? `${sizeKb.toLocaleString()} KB (${sizeBytes.toLocaleString()} bytes)` : null,
                'File ID': match.id || null,
                'Uploader': author,
                'Channel ID': channelId,
                'Shared in channels': sharedIn ? `${sharedIn}` : null,
                'Comments': commentsCount != null ? `${commentsCount}` : null,
                'Public permalink': match.permalink_public || null,
                'Private URL': match.url_private || null,
            },
        });
    }

    return items;
}

async function searchSlack(query) {
    const tokens = tokenStore.get('slack');
    if (!tokens) {
        throw new Error('Slack not authenticated');
    }

    const teamId = tokens.slackTeamId || process.env.SLACK_TEAM_ID;
    if (!teamId) {
        throw new Error('Slack team ID not available — please re-login');
    }

    const timeout = Number(process.env.SEARCH_TIMEOUT_MS || 15000);
    const maxResults = Number(process.env.MAX_RESULTS_PER_SOURCE || 50);
    // Roughly split the requested limit between the two modules. The pagination
    // loop inside fetchSlackModule will keep fetching pages until it reaches
    // this target (or hits the last page / safety cap).
    const perModuleCount = Math.ceil(maxResults * 0.65);

    let win;

    try {
        logger.info('Phase 3', 'Searching Slack for "' + query + '"');

        // Load the workspace homepage to get an authenticated page context
        const workspaceUrl = 'https://app.slack.com/client/' + teamId;
        win = await createHiddenSlackWindow(workspaceUrl);

        // Wait for page to be ready
        await waitForSlackReady(win, Math.floor(timeout / 3));

        // Extract the API token using multiple strategies
        const tokenInfo = await extractApiToken(win);
        logger.info('Phase 3', 'Slack token extraction result', {
            source: tokenInfo.source,
            hasToken: tokenInfo.token !== null,
        });

        if (!tokenInfo.token) {
            logger.warn('Phase 3', 'Could not find Slack API token via any strategy');
            return [];
        }

        // Query both messages and files modules in parallel
        const [msgResult, fileResult] = await Promise.allSettled([
            fetchSlackModule(win, tokenInfo.token, query, 'messages', perModuleCount),
            fetchSlackModule(win, tokenInfo.token, query, 'files', perModuleCount),
        ]);

        // Combine results from both modules
        const allItems = [];

        // Process messages
        if (msgResult.status === 'fulfilled' && msgResult.value && msgResult.value.ok && msgResult.value.data) {
            const msgItems = mapMessageResults(msgResult.value.data.messages, teamId, tokens.baseUrl);
            allItems.push(...msgItems);
            logger.info('Phase 3', 'Slack messages module returned ' + msgItems.length + ' results');
        } else if (msgResult.status === 'fulfilled' && msgResult.value && msgResult.value.error) {
            logger.warn('Phase 3', 'Slack messages API failed: ' + msgResult.value.error);
        } else if (msgResult.status === 'rejected') {
            logger.warn('Phase 3', 'Slack messages module rejected: ' + msgResult.reason.message);
        }

        // Process files
        if (fileResult.status === 'fulfilled' && fileResult.value && fileResult.value.ok && fileResult.value.data) {
            const fileItems = mapFileResults(fileResult.value.data.files, teamId, tokens.baseUrl);
            allItems.push(...fileItems);
            logger.info('Phase 3', 'Slack files module returned ' + fileItems.length + ' results');
        } else if (fileResult.status === 'fulfilled' && fileResult.value && fileResult.value.error) {
            logger.warn('Phase 3', 'Slack files API failed: ' + fileResult.value.error);
        } else if (fileResult.status === 'rejected') {
            logger.warn('Phase 3', 'Slack files module rejected: ' + fileResult.reason.message);
        }

        // If no results at all, write debug snapshot
        if (allItems.length === 0) {
            const debugPath = path.join(process.cwd(), 'slack-debug.json');
            const msgData = (msgResult.status === 'fulfilled' && msgResult.value) ? msgResult.value : null;
            fs.writeFileSync(debugPath, JSON.stringify({
                query,
                workspaceUrl,
                tokenSource: tokenInfo.source,
                messagesOk: msgData ? msgData.ok : null,
                messageCount: msgData && msgData.data && msgData.data.messages && msgData.data.messages.matches
                    ? msgData.data.messages.matches.length : 0,
                messagesPagination: msgData && msgData.data && msgData.data.messages && msgData.data.messages.pagination
                    ? msgData.data.messages.pagination : null,
                capturedAt: new Date().toISOString(),
            }, null, 2));
            logger.warn('Phase 3', 'Slack returned 0 results across all modules; wrote debug snapshot');
        }

        // Cap to max results with nice interleaving: interleave messages and files
        const capped = [];
        const msgPool = allItems.filter((i) => i.type === 'Message' || !i.type);
        const filePool = allItems.filter((i) => i.type !== 'Message' && i.type);

        // Interleave: prefer 4 messages then 1 file for natural feel
        let msgIdx = 0;
        let fileIdx = 0;
        while (capped.length < maxResults && (msgIdx < msgPool.length || fileIdx < filePool.length)) {
            // Add up to 4 messages
            for (let j = 0; j < 4 && msgIdx < msgPool.length && capped.length < maxResults; j++) {
                capped.push(msgPool[msgIdx]);
                msgIdx++;
            }
            // Add 1 file
            if (fileIdx < filePool.length && capped.length < maxResults) {
                capped.push(filePool[fileIdx]);
                fileIdx++;
            }
        }

        logger.success('Phase 3', 'Slack returned ' + capped.length + ' results (' + msgPool.length + ' messages, ' + filePool.length + ' files)');
        return capped;
    } catch (error) {
        if (error.message === 'AUTH_EXPIRED') {
            throw error;
        }

        logger.error('Phase 3', 'Slack search failed', error);
        return [];
    } finally {
        if (win && !win.isDestroyed()) {
            win.close();
        }
    }
}

module.exports = { searchSlack };
