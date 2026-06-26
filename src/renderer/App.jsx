import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SearchBar from './components/SearchBar';
import ResultCard from './components/ResultCard';
import LoginPanel from './components/LoginPanel';
import SettingsPanel from './components/SettingsPanel';
import LoadingSpinner from './components/LoadingSpinner';
import AIAnswer, { renderMarkdown } from './components/AIAnswer';
import ExpertPanel from './components/ExpertPanel';
import Dashboard from './components/Dashboard';
import Logo from './components/Logo';
import { useTheme } from './hooks/useTheme';
import { welcomeConfetti } from './utils/confetti';

const SOURCE_FILTERS = ['All', 'Slack', 'Confluence', 'ServiceNow', 'Atlassian', 'Box', 'Jira', 'Resources', 'Datadog', 'AWS'];

export default function App() {
    const { preference: themePref, cycle: cycleTheme } = useTheme();
    const [authStatus, setAuthStatus] = useState({ slack: false, confluence: false, servicenow: false, atlassian: false, box: false, jira: false, resources: false, datadog: false, aws: false });
    const [results, setResults] = useState([]);
    const [sourceStats, setSourceStats] = useState({});
    const [errors, setErrors] = useState({});
    const [isLoading, setIsLoading] = useState(false);
    const [query, setQuery] = useState('');
    const [activeFilter, setActiveFilter] = useState('All');
    const [timeTaken, setTimeTaken] = useState(null);
    const [view, setView] = useState('search');
    const [todayCost, setTodayCost] = useState(null);
    const [reindexing, setReindexing] = useState(false);
    const [aiOpen, setAiOpen] = useState(false);
    const resultRefs = useRef({});
    const aiCitationClick = useCallback((n) => {
        const el = resultRefs.current[n - 1];
        if (el && el.scrollIntoView) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('ring-2', 'ring-indigo-400', 'dark:ring-indigo-500');
            setTimeout(() => el.classList.remove('ring-2', 'ring-indigo-400', 'dark:ring-indigo-500'), 1500);
        }
    }, []);
    const [slackPanelUrl, setSlackPanelUrl] = useState(null);
    const [slackKey, setSlackKey] = useState(0);
    const searchRequestIdRef = useRef(0);
    const webviewRef = useRef(null);
    const lastSlackUrlRef = useRef(null);

    // Embedded ServiceNow agent-UI panel. Reuses the same authenticated
    // partition as the connector (persist:perfectsearch-servicenow), so the
    // webview is logged in via the user's existing SSO session — no second
    // login. `snowUrl` is the instance base; ServiceNow redirects to the
    // user's default workspace and the user navigates freely from there.
    const [snowUrl, setSnowUrl] = useState(null);
    const snowWebviewRef = useRef(null);
    const isSnowPanelOpen = Boolean(snowUrl);

    const openServiceNowPanel = useCallback(async () => {
        try {
            // Resolve the effective URL (auth token → config → env) — the URL is
            // usually on the auth token, not in config.servicenow.
            const res = await window.perfectsearch.getSourceUrl('servicenow');
            const base = res && res.url;
            if (!base) {
                setErrors((prev) => ({ ...prev, global: 'ServiceNow instance URL not set. Open Settings → ServiceNow URL first.' }));
                return;
            }
            // Opening the ServiceNow panel takes over the right column — close
            // the Slack panel if it's open so they don't fight for space.
            setSlackPanelUrl(null);
            setSnowUrl(base.replace(/\/$/, ''));
        } catch (err) {
            setErrors((prev) => ({ ...prev, global: `Could not open ServiceNow: ${err && err.message}` }));
        }
    }, []);

    const handleCloseSnowPanel = useCallback(() => {
        if (snowWebviewRef.current) {
            try { snowWebviewRef.current.stop(); } catch (_) { /* ignore */ }
        }
        setSnowUrl(null);
    }, []);

    // "✨ Analyze case" — read the case the embedded ServiceNow webview is on,
    // and stream an AI diagnosis (summary, root cause, troubleshooting).
    const [analyzeStatus, setAnalyzeStatus] = useState('idle'); // idle|streaming|done|error
    const [analyzeText, setAnalyzeText] = useState('');
    const [analyzeError, setAnalyzeError] = useState(null);
    const [analyzeMeta, setAnalyzeMeta] = useState(null);
    const analyzeReqRef = useRef(0);

    const handleAnalyzeCase = useCallback(async () => {
        const wv = snowWebviewRef.current;
        if (!wv) return;
        let currentUrl = '';
        let wcId = null;
        try { currentUrl = wv.getURL(); } catch (_) { /* ignore */ }
        try { wcId = wv.getWebContentsId(); } catch (_) { /* ignore */ }

        // ServiceNow's split-pane UI loads the case in an inner frame, so
        // wv.getURL() returns the nav-shell URL without a sys_id. Try to pull
        // the real record URL from the page via JS (checks all iframes + the
        // document URL + the g_form object that SN sets for the active record).
        try {
            const deepUrl = await wv.executeJavaScript(`(function(){
                var numPat = /\\b(CSC|INC|RITM|CHG|PRB)\\d{4,}/i;
                var hexPat = /[0-9a-f]{32}/i;
                var sysIdPat = /sys_id=([0-9a-f]{32})/i;
                var recPat = /\\/record\\/[a-z0-9_]+\\/([0-9a-f]{32})/i;

                // 1. g_form.getUniqueValue() — set on any classic SN form
                if (window.g_form && window.g_form.getUniqueValue) {
                    try { var sid = window.g_form.getUniqueValue(); if (sid && sid.length === 32) return 'sys_id://' + sid; } catch(_){}
                }

                // 2. Decode the current URL fully — SN workspace puts the real
                //    target URL as an encoded param: /nav/...?target=case.do%3Fsys_id%3D...
                var decoded = '';
                try { decoded = decodeURIComponent(decodeURIComponent(location.href)); } catch(_) { try { decoded = decodeURIComponent(location.href); } catch(_){} }
                var dm = decoded.match(sysIdPat) || decoded.match(recPat);
                if (dm) return decoded;

                // 3. Scan all iframe src attributes (not contentWindow — avoids cross-origin block)
                try {
                    var frames = Array.from(document.querySelectorAll('iframe[src]'));
                    for (var f = 0; f < frames.length; f++) {
                        var src = frames[f].getAttribute('src') || '';
                        try { src = decodeURIComponent(src); } catch(_){}
                        if (sysIdPat.test(src) || recPat.test(src)) return src;
                    }
                } catch(_){}

                // 4. Look for 32-hex IDs in the current page's URL hash/params
                var hashAndSearch = location.hash + location.search;
                var hm = hashAndSearch.match(hexPat);
                if (hm && hm[0].length === 32) return 'sys_id://' + hm[0];

                // 5. Extract case number from visible form fields (value= attributes)
                try {
                    var inputs = Array.from(document.querySelectorAll('input[value]'));
                    for (var i = 0; i < inputs.length; i++) {
                        var v = inputs[i].value || inputs[i].getAttribute('value') || '';
                        var nm = v.match(numPat);
                        if (nm) return 'case-number://' + nm[0].toUpperCase();
                    }
                } catch(_){}

                // 6. Title, then full body text (last resort)
                var m2 = (document.title || '').match(numPat);
                if (!m2) { try { m2 = (document.body && document.body.innerText || '').slice(0, 50000).match(numPat); } catch(_){} }
                if (m2) return 'case-number://' + m2[0].toUpperCase();

                return 'debug://' + encodeURIComponent(location.href.slice(0, 200));
            })()`);
            console.log('[analyze-case] deepUrl result:', deepUrl, '| outer URL:', currentUrl.slice(0, 120));
            if (deepUrl && deepUrl.length > 0 && !deepUrl.startsWith('debug://')) currentUrl = deepUrl;
            else if (deepUrl && deepUrl.startsWith('debug://')) console.warn('[analyze-case] JS found nothing; outer URL was:', currentUrl);
        } catch (jsErr) { console.error('[analyze-case] executeJavaScript failed:', jsErr && jsErr.message); }

        const requestId = ++analyzeReqRef.current;
        setAnalyzeStatus('streaming');
        setAnalyzeText('');
        setAnalyzeError(null);
        setAnalyzeMeta(null);
        try {
            const resp = await window.perfectsearch.analyzeServiceNowCase(
                requestId, currentUrl, wcId,
                (delta) => { if (requestId === analyzeReqRef.current) setAnalyzeText((p) => p + delta); }
            );
            if (requestId !== analyzeReqRef.current) return;
            if (resp.success) {
                setAnalyzeMeta(resp.data);
                // If streaming chunks never arrived (IPC timing edge-case), fall
                // back to the full text returned in the response payload.
                if (resp.data && resp.data.text) {
                    setAnalyzeText((prev) => prev || resp.data.text);
                }
                setAnalyzeStatus('done');
            } else {
                setAnalyzeError(resp.error);
                setAnalyzeStatus('error');
            }
        } catch (e) {
            if (requestId !== analyzeReqRef.current) return;
            setAnalyzeError(e.message);
            setAnalyzeStatus('error');
        }
    }, []);

    const closeAnalyze = useCallback(() => {
        analyzeReqRef.current += 1; // cancel any in-flight stream updates
        setAnalyzeStatus('idle');
        setAnalyzeText('');
        setAnalyzeError(null);
        setAnalyzeMeta(null);
    }, []);

    // Clicking a [N] citation in the analysis opens that source (KB article,
    // Slack thread, Confluence page, …) in the browser.
    const onAnalyzeCitation = useCallback((n) => {
        const src = analyzeMeta && analyzeMeta.sources && analyzeMeta.sources[n - 1];
        if (src && src.link) { try { window.perfectsearch.openLink(src.link); } catch (_) { /* ignore */ } }
    }, [analyzeMeta]);

    // Derive a stable workspace identifier so the webview is only recreated
    // when switching workspaces. Works for both:
    //   - canonical permalinks: https://{workspace}.slack.com/archives/...
    //   - app-client URLs:      https://app.slack.com/client/{teamId}/...
    const slackTeamId = useMemo(() => {
        if (!slackPanelUrl) return null;
        const appClient = slackPanelUrl.match(/^https:\/\/app\.slack\.com\/client\/([A-Za-z0-9]+)/);
        if (appClient) return appClient[1];
        const subdomain = slackPanelUrl.match(/^https:\/\/([^.]+)\.(?:enterprise\.)?slack\.com\//);
        return subdomain ? subdomain[1] : null;
    }, [slackPanelUrl]);

    // Navigate the webview when slackPanelUrl changes.
    // Strategy: webview src is the canonical Slack permalink URL — Slack's own
    // server/SPA handles the deep-link redirect. For subsequent same-workspace
    // clicks, we call wv.loadURL() since the SPA may not honour pushState alone.
    useEffect(() => {
        const wv = webviewRef.current;
        if (!wv || !slackPanelUrl) return;

        if (!lastSlackUrlRef.current) {
            // First open — the webview src= attribute is already loading the URL.
            lastSlackUrlRef.current = slackPanelUrl;
            return;
        }
        if (slackPanelUrl === lastSlackUrlRef.current) return;
        lastSlackUrlRef.current = slackPanelUrl;

        console.log('[webview] navigating to:', slackPanelUrl);
        try {
            const p = wv.loadURL(slackPanelUrl);
            if (p && typeof p.catch === 'function') {
                p.catch((err) => { if (err && err.errno !== -3) console.error('[webview] loadURL err:', err); });
            }
        } catch (_) { /* ignore */ }
    }, [slackPanelUrl]);

    // --- Wire up webview navigation guards ---
    useEffect(() => {
        const wv = webviewRef.current;
        if (!wv) return;

        // Log every will-navigate so we can see exactly which URLs Slack tries
        // to go to (including server-side redirects to slack:// or login pages).
        // We only preventDefault() for the slack:// protocol so it doesn't open
        // the Slack desktop app; everything else is allowed to proceed.
        const blockRedirect = (e) => {
            const url = e.url || '';
            console.log('[webview] will-navigate:', url);
            if (url.startsWith('slack://')) {
                console.log('[webview] BLOCKING slack:// redirect');
                e.preventDefault();
            }
        };

        const blockNewWindow = (e) => {
            console.log('[webview] new-window blocked:', e.url);
            e.preventDefault();
        };

        // Detailed failure logger — gives the actual reason a navigation
        // failed, distinguishing ERR_ABORTED from network errors, etc.
        const onDidFailLoad = (e) => {
            // -3 is the user-initiated/programmatic cancel; everything else is
            // an actual load problem.
            console.error(
                '[webview] did-fail-load code=' + e.errorCode
                + ' desc=' + e.errorDescription
                + ' url=' + e.validatedURL
                + ' isMain=' + e.isMainFrame
            );
        };

        const onDidStartNavigation = (e) => {
            console.log('[webview] did-start-navigation:', e.url, 'isMain=' + e.isMainFrame);
        };

        // Inject defenses BEFORE Slack's bundle gets a chance to redirect to
        // the desktop app. Strategies:
        //  1. Override navigator.userAgent so Slack treats us as plain Chrome.
        //  2. Override window.location setters to drop any slack:// assignment.
        //  3. Stub window.open for slack:// URLs.
        //  4. Set localStorage flags that mark the "open in desktop app"
        //     banner as already dismissed.
        const onDomReady = () => {
            try {
                wv.executeJavaScript(`
                    (function () {
                        try {
                            Object.defineProperty(navigator, 'userAgent', {
                                get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                                configurable: true
                            });
                            Object.defineProperty(navigator, 'appVersion', {
                                get: () => '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                                configurable: true
                            });
                        } catch (_) {}

                        try {
                            // Stub window.open for slack:// so Slack can't pop the desktop app.
                            const origOpen = window.open;
                            window.open = function (url, name, features) {
                                if (typeof url === 'string' && url.indexOf('slack:') === 0) {
                                    console.log('[PerfectSearch] blocked window.open(slack:):', url);
                                    return null;
                                }
                                return origOpen.apply(window, arguments);
                            };
                        } catch (_) {}

                        try {
                            // Override location assign / replace / href setter for slack:// URLs.
                            const origAssign = window.location.assign.bind(window.location);
                            const origReplace = window.location.replace.bind(window.location);
                            window.location.assign = function (u) {
                                if (typeof u === 'string' && u.indexOf('slack:') === 0) {
                                    console.log('[PerfectSearch] blocked location.assign(slack:):', u);
                                    return;
                                }
                                return origAssign(u);
                            };
                            window.location.replace = function (u) {
                                if (typeof u === 'string' && u.indexOf('slack:') === 0) {
                                    console.log('[PerfectSearch] blocked location.replace(slack:):', u);
                                    return;
                                }
                                return origReplace(u);
                            };
                        } catch (_) {}

                        try {
                            // Slack reads localStorage flags to decide whether to show the
                            // "open in desktop app" interstitial. Pre-dismiss them.
                            localStorage.setItem('TS_clientApp_banner_dismissed', '1');
                            localStorage.setItem('perfectsearch_no_desktop_redirect', '1');
                        } catch (_) {}

                        // Slack's archives/.../p... pages render a OneTrust cookie
                        // consent banner that blocks the page-redirect JS until
                        // dismissed. Aggressively neutralise OneTrust on every
                        // possible front: pre-set the consent cookies, hide its
                        // DOM via CSS, call its API, and physically remove its
                        // modal elements on a poll.
                        try {
                            const yearFromNow = new Date(Date.now() + 365 * 24 * 3600e3).toUTCString();
                            // OptanonAlertBoxClosed = ISO timestamp dismisses the banner
                            document.cookie = 'OptanonAlertBoxClosed=' + new Date().toISOString() + '; path=/; domain=.slack.com; expires=' + yearFromNow;
                            // OptanonConsent = a consent string that opts in to all categories
                            const consent = 'isGpcEnabled=0&datestamp=' + encodeURIComponent(new Date().toString())
                                + '&version=202401.1.0&isIABGlobal=false&hosts=&consentId=00000000-0000-0000-0000-000000000000'
                                + '&interactionCount=1&landingPath=NotLandingPage&groups=C0001:1,C0002:1,C0003:1,C0004:1,C0005:1';
                            document.cookie = 'OptanonConsent=' + consent + '; path=/; domain=.slack.com; expires=' + yearFromNow;
                            console.log('[PerfectSearch] OneTrust consent cookies set');
                        } catch (_) {}

                        try {
                            // CSS-hide every OneTrust artifact (covers cases where
                            // we can't .remove() because the element loads later).
                            const style = document.createElement('style');
                            style.textContent =
                                '#onetrust-consent-sdk,#onetrust-banner-sdk,#onetrust-pc-sdk,' +
                                '.onetrust-pc-dark-filter,#ot-sdk-btn-floating,.ot-floating-button,' +
                                '.ot-sdk-row,#onetrust-group-container{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;}';
                            (document.head || document.documentElement).appendChild(style);
                        } catch (_) {}

                        function killOneTrust() {
                            let didSomething = false;
                            try {
                                if (window.OneTrust && typeof window.OneTrust.AllowAll === 'function') {
                                    window.OneTrust.AllowAll();
                                    didSomething = true;
                                }
                                const sels = ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk', '.onetrust-pc-dark-filter'];
                                for (const sel of sels) {
                                    document.querySelectorAll(sel).forEach((el) => { el.remove(); didSomething = true; });
                                }
                            } catch (_) {}
                            return didSomething;
                        }
                        killOneTrust();
                        let killTries = 0;
                        const killTimer = setInterval(function () {
                            killTries++;
                            killOneTrust();
                            if (killTries > 60) clearInterval(killTimer);
                        }, 250);
                    })();
                `).catch(() => {});
            } catch (_) { /* ignore */ }
            console.log('[webview] dom-ready, URL:', wv.getURL());
        };

        const onDidFinishLoad = () => {
            console.log('[webview] did-finish-load, URL:', wv.getURL());
            // Probe the page after a delay so any post-load JS has settled.
            // Goal: figure out what's actually visible in the panel.
            setTimeout(() => {
                wv.executeJavaScript(`
                    (function () {
                        const out = {
                            url: location.href,
                            title: document.title,
                            bodyLen: document.body ? document.body.innerHTML.length : -1,
                            innerText: document.body ? document.body.innerText.substring(0, 600) : '(no body)',
                            hasLoginForm: !!document.querySelector('input[type="password"], form[action*="signin"], a[href*="signin"]'),
                            hasOpenInAppBanner: /(open in app|launch the slack app|continue in browser|use the app)/i.test(document.body ? document.body.innerText : ''),
                            firstHeading: (document.querySelector('h1,h2') || {}).innerText || null,
                            visibleButtons: Array.from(document.querySelectorAll('button,a.c-button,a.p-download_modal__button')).slice(0,8).map(b => (b.innerText||'').trim().substring(0,60)).filter(Boolean),
                        };
                        return JSON.stringify(out);
                    })();
                `).then((r) => console.log('[webview] PAGE-PROBE:', r))
                  .catch((e) => console.error('[webview] PAGE-PROBE err:', e && e.message));
            }, 5000);
        };

        const logNavigate = (e) => {
            console.log('[webview] navigate:', e.type, e.url);
        };

        // Forward Slack webview console output to the renderer console so the
        // diagnostic logs (especially our injected ones above) land in DevTools.
        const onConsoleMessage = (e) => {
            console.log('[slack-webview-console]', e.level || '?', e.message);
        };

        wv.addEventListener('will-navigate', blockRedirect);
        wv.addEventListener('new-window', blockNewWindow);
        wv.addEventListener('did-fail-load', onDidFailLoad);
        wv.addEventListener('did-start-navigation', onDidStartNavigation);
        wv.addEventListener('dom-ready', onDomReady);
        wv.addEventListener('did-finish-load', onDidFinishLoad);
        wv.addEventListener('did-navigate', logNavigate);
        wv.addEventListener('did-navigate-in-page', logNavigate);
        wv.addEventListener('console-message', onConsoleMessage);

        return () => {
            wv.removeEventListener('will-navigate', blockRedirect);
            wv.removeEventListener('new-window', blockNewWindow);
            wv.removeEventListener('did-fail-load', onDidFailLoad);
            wv.removeEventListener('did-start-navigation', onDidStartNavigation);
            wv.removeEventListener('dom-ready', onDomReady);
            wv.removeEventListener('did-finish-load', onDidFinishLoad);
            wv.removeEventListener('did-navigate', logNavigate);
            wv.removeEventListener('did-navigate-in-page', logNavigate);
            wv.removeEventListener('console-message', onConsoleMessage);
        };
        // Re-run when `slackKey` changes (workspace switch → webview recreated)
        // OR when slackPanelUrl flips from null → set (webview was just mounted).
        // The boolean coercion keeps the dep stable across same-workspace URL
        // changes so we don't tear down listeners on every click.
    }, [slackKey, Boolean(slackPanelUrl)]);

    const anyConnected = useMemo(() => Object.values(authStatus).some(Boolean), [authStatus]);

    const loadAuthStatus = useCallback(async () => {
        const status = await window.perfectsearch.getAuthStatus();
        setAuthStatus(status);
    }, []);

    useEffect(() => {
        loadAuthStatus();
    }, [loadAuthStatus]);

    // Keep the header "today spend" badge fresh — on launch and whenever the
    // view changes (e.g. after running the Expert, returning from the dashboard).
    useEffect(() => {
        (async () => {
            try {
                const r = await window.perfectsearch.usageSummary();
                if (r.success) setTodayCost(r.summary.today.cost || 0);
            } catch (_) { /* ignore */ }
        })();
    }, [view]);

    // Welcome confetti — fires once per app launch when the dashboard mounts.
    // Empty dep array + a top-level guard keeps it from re-running if React
    // strict-mode double-invokes the effect during development.
    const welcomedRef = useRef(false);
    useEffect(() => {
        if (welcomedRef.current) return;
        welcomedRef.current = true;
        welcomeConfetti();
    }, []);

    // Listen for main process telling us to open the Slack side panel
    useEffect(() => {
        const unsub = window.perfectsearch.onSlackPanelOpened((url) => {
            console.log('[webview] slack-panel:opened, url:', url);
            // When a different workspace is requested, bump the key to force
            // the webview to recreate. Same workspace = same key, so the webview
            // just navigates to the new src. Both URL shapes are supported:
            //   - canonical: https://{workspace}.slack.com/archives/...
            //   - app-client: https://app.slack.com/client/{teamId}/...
            let newTeamId = null;
            const appClient = url.match(/^https:\/\/app\.slack\.com\/client\/([A-Za-z0-9]+)/);
            if (appClient) {
                newTeamId = appClient[1];
            } else {
                const wsHost = url.match(/^https:\/\/([^.]+)\.(?:enterprise\.)?slack\.com\//);
                newTeamId = wsHost ? wsHost[1] : null;
            }
            if (newTeamId && newTeamId !== slackTeamId) {
                setSlackKey((k) => k + 1);
            }
            setSlackPanelUrl(url);
        });
        return () => {
            unsub();
        };
    }, [slackTeamId]);

    const handleCloseSlackPanel = useCallback(() => {
        if (webviewRef.current) {
            try {
                webviewRef.current.stop();
            } catch (_) {
                // ignore
            }
        }
        setSlackPanelUrl(null);
    }, []);

    const handleSearch = useCallback(async (nextQuery) => {
        const requestId = searchRequestIdRef.current + 1;
        searchRequestIdRef.current = requestId;

        setQuery(nextQuery);

        if (!nextQuery || nextQuery.trim().length < 2) {
            setResults([]);
            setSourceStats({});
            setErrors({});
            setTimeTaken(null);
            return;
        }

        setIsLoading(true);
        setActiveFilter('All');
        setErrors({});
        setAiOpen(false);

        try {
            const response = await window.perfectsearch.search(nextQuery);
            if (requestId !== searchRequestIdRef.current) {
                return;
            }

            if (response.success) {
                setResults(response.data.results || []);
                setSourceStats(response.data.sources || {});
                setErrors(response.data.errors || {});
                setTimeTaken(response.data.timeTaken || null);
            } else {
                setResults([]);
                setErrors({ global: response.error });
            }
        } catch (error) {
            if (requestId !== searchRequestIdRef.current) {
                return;
            }

            setResults([]);
            setErrors({ global: error.message });
        } finally {
            if (requestId === searchRequestIdRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    const filteredResults = activeFilter === 'All'
        ? results
        : results.filter((result) => result.source === activeFilter);

    const handleReindex = useCallback(async () => {
        setReindexing(true);
        await window.perfectsearch.reindexWebsite();
        setReindexing(false);
    }, []);

    // Switch to settings view AND scroll to the top so the LoginPanel/
    // SettingsPanel that just appeared above the search area is actually
    // visible — otherwise users clicking "Open Settings" from a deep-scrolled
    // AI card see no obvious change.
    const openSettings = useCallback(() => {
        setView('settings');
        // Defer the scroll until after React paints the settings panel.
        requestAnimationFrame(() => {
            const mainEl = document.querySelector('main');
            if (mainEl) mainEl.scrollTop = 0;
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }, []);

    const isSlackPanelOpen = Boolean(slackPanelUrl);
    const isRightPanelOpen = isSlackPanelOpen || isSnowPanelOpen;

    // Resizable split between the left (search) column and the right panel.
    // leftWidthPct is the left column's width as a % of the window; the divider
    // drags it, double-click resets to 55/45.
    const [leftWidthPct, setLeftWidthPct] = useState(55);
    const [isDragging, setIsDragging] = useState(false);
    const onDividerDrag = useCallback((e) => {
        const pct = (e.clientX / window.innerWidth) * 100;
        setLeftWidthPct(Math.min(85, Math.max(15, pct)));
    }, []);

    const themeIcon = themePref === 'dark' ? '☀️' : themePref === 'light' ? '🌙' : '🖥️';
    const themeLabel = themePref === 'dark' ? 'Switch to light' : themePref === 'light' ? 'Use system theme' : 'Switch to dark';

    return (
        <div className="h-screen overflow-hidden flex flex-row text-slate-900 dark:text-slate-100">
            {/* LEFT COLUMN — search interface */}
            <div
                className={`flex flex-col h-full overflow-hidden ${isDragging ? '' : 'transition-all duration-300 ease-in-out'}`}
                style={{
                    flex: isRightPanelOpen ? `0 0 ${leftWidthPct}%` : '1 1 auto',
                    maxWidth: isRightPanelOpen ? `${leftWidthPct}%` : '100%',
                }}
            >
                <header className="glass-header sticky top-0 z-30 px-6 py-3 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <Logo size={44} withGlow />
                        <span className="font-extrabold tracking-tight text-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent">
                            PerfectSearch
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {[
                            { id: 'slack', label: 'SL', color: 'bg-purple-500' },
                            { id: 'confluence', label: 'CF', color: 'bg-blue-500' },
                            { id: 'servicenow', label: 'SN', color: 'bg-green-500' },
                            { id: 'atlassian', label: 'AT', color: 'bg-sky-500' },
                            { id: 'box', label: 'BX', color: 'bg-indigo-500' },
                            { id: 'jira', label: 'JR', color: 'bg-cyan-500' },
                            { id: 'resources', label: 'ER', color: 'bg-amber-500' },
                        ].map((source) => (
                            <div
                                key={source.id}
                                title={`${source.id}: ${authStatus[source.id] ? 'connected' : 'disconnected'}`}
                                className={`w-7 h-7 rounded-full text-white text-[10px] flex items-center justify-center font-bold transition-all ${authStatus[source.id] ? `${source.color} shadow-sm ring-2 ring-white dark:ring-slate-900` : 'bg-slate-300 dark:bg-slate-700'}`}
                            >
                                {source.label}
                            </div>
                        ))}
                        {isSlackPanelOpen && (
                            <button
                                type="button"
                                onClick={handleCloseSlackPanel}
                                className="ml-1 text-xs px-3 py-1.5 rounded-md bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900 font-medium transition-colors"
                                title="Close Slack panel"
                            >
                                ✕ Close Slack
                            </button>
                        )}
                        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />
                        <button
                            type="button"
                            onClick={isSnowPanelOpen ? handleCloseSnowPanel : openServiceNowPanel}
                            title={isSnowPanelOpen ? 'Close ServiceNow panel' : 'Open ServiceNow (your dashboard, cases, KB) in an embedded tab'}
                            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${isSnowPanelOpen ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900' : 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-950 dark:text-green-300 dark:hover:bg-green-900'}`}
                        >
                            {isSnowPanelOpen ? '✕ Close ServiceNow' : '🧭 ServiceNow'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setView((v) => (v === 'expert' ? 'search' : 'expert'))}
                            title="Ask AI Expert — work an issue conversationally"
                            className={`ml-1 text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${view === 'expert' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900'}`}
                        >
                            🧠 Ask AI Expert
                        </button>
                        <button
                            type="button"
                            onClick={() => setView((v) => (v === 'dashboard' ? 'search' : 'dashboard'))}
                            title={`AI usage & cost${todayCost != null ? ` — today ~$${todayCost.toFixed(todayCost < 1 ? 4 : 2)}` : ''}`}
                            className={`ml-1 text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${view === 'dashboard' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
                        >
                            📊 {todayCost != null ? `$${todayCost.toFixed(todayCost < 1 ? 3 : 2)}` : 'Usage'}
                        </button>
                        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />
                        <button
                            type="button"
                            onClick={cycleTheme}
                            title={themeLabel + ' (currently: ' + themePref + ')'}
                            className="text-base p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                            <span aria-hidden="true">{themeIcon}</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setView((currentView) => (currentView === 'settings' ? 'search' : 'settings'))}
                            title="Settings"
                            className={`text-base p-1.5 rounded-lg transition-colors ${view === 'settings' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                        >
                            ⚙️
                        </button>
                    </div>
                </header>

                {view === 'settings' && (
                    <div className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/60 backdrop-blur-sm animate-fade-in">
                        <LoginPanel authStatus={authStatus} onAuthChange={loadAuthStatus} />
                        <SettingsPanel reindexing={reindexing} onReindex={handleReindex} />
                    </div>
                )}

                {view === 'expert' && <ExpertPanel />}
                {view === 'dashboard' && <Dashboard />}

                <main className={`flex-1 w-full mx-auto px-4 py-6 flex flex-col gap-5 overflow-y-auto ${view === 'expert' || view === 'dashboard' ? 'hidden' : ''}`} style={{ maxWidth: '56rem' }}>
                    {!query && (
                        <div className="text-center pt-4 pb-2 animate-fade-in">
                            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent">
                                Welcome to Your Perfect Search Portal
                            </h1>
                            <p className="mt-2 text-sm sm:text-base text-slate-600 dark:text-slate-400">
                                Make your Search result Perfect
                            </p>
                        </div>
                    )}

                    <SearchBar onSearch={handleSearch} isLoading={isLoading} resultCount={results.length > 0 ? results.length : null} />

                    {!anyConnected && !query && (
                        <div className="text-center py-16 animate-fade-in">
                            <p className="text-5xl mb-4">🔌</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200 text-lg mb-1">No sources connected</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
                                Open settings and connect Slack, Confluence, ServiceNow, Atlassian, Box, or Jira to begin searching.
                            </p>
                            <button
                                type="button"
                                onClick={openSettings}
                                className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-sm px-6 py-2.5 rounded-lg font-medium shadow-lg shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40 hover:-translate-y-0.5"
                            >
                                Connect now →
                            </button>
                        </div>
                    )}

                    {isLoading && <LoadingSpinner message="Searching across all sources…" />}

                    {!isLoading && results.length > 0 && (
                        <>
                            <div className="flex items-center justify-between flex-wrap gap-2 animate-fade-in">
                                <div className="flex gap-1.5 flex-wrap">
                                    {SOURCE_FILTERS.map((filter) => {
                                        const isActive = activeFilter === filter;
                                        const count = filter === 'All' ? results.length : sourceStats[filter.toLowerCase()];
                                        return (
                                            <button
                                                key={filter}
                                                type="button"
                                                onClick={() => setActiveFilter(filter)}
                                                className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all ${isActive
                                                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white shadow-sm'
                                                    : 'bg-white/70 text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-white dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200'}`}
                                            >
                                                {filter}
                                                {count !== undefined && filter !== 'All' && (
                                                    <span className={`ml-1.5 ${isActive ? 'opacity-70' : 'opacity-60'}`}>{count}</span>
                                                )}
                                                {filter === 'All' && (
                                                    <span className={`ml-1.5 ${isActive ? 'opacity-70' : 'opacity-60'}`}>{count}</span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setAiOpen((v) => !v)}
                                        className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-all
                                            ${aiOpen
                                                ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-md shadow-indigo-500/30'
                                                : 'bg-gradient-to-r from-indigo-500/10 to-purple-500/10 dark:from-indigo-500/20 dark:to-purple-500/20 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 hover:from-indigo-500/20 hover:to-purple-500/20'}`}
                                        title="Ask AI to synthesize an answer from these results"
                                    >
                                        ✨ {aiOpen ? 'Hide AI answer' : 'Ask AI'}
                                    </button>
                                    {timeTaken !== null && (
                                        <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                                            {filteredResults.length} results · {timeTaken}ms
                                        </span>
                                    )}
                                </div>
                            </div>

                            {aiOpen && (
                                <div className="flex flex-col gap-3">
                                    <AIAnswer
                                        key={`ai-internal-${query}`}
                                        query={query}
                                        results={filteredResults}
                                        mode="internal"
                                        onCitationClick={aiCitationClick}
                                        onOpenSettings={openSettings}
                                    />
                                    <AIAnswer
                                        key={`ai-web-${query}`}
                                        query={query}
                                        results={filteredResults}
                                        mode="web"
                                        onOpenSettings={openSettings}
                                    />
                                </div>
                            )}

                            <div className="flex flex-col gap-3">
                                {filteredResults.length > 0
                                    ? filteredResults.map((result, i) => (
                                        <div key={result.id} ref={(el) => { resultRefs.current[i] = el; }} className="transition-shadow">
                                            <ResultCard result={result} query={query} />
                                        </div>
                                    ))
                                    : <p className="text-center text-slate-400 dark:text-slate-500 text-sm py-8">No {activeFilter} results for this query.</p>}
                            </div>
                        </>
                    )}

                    {!isLoading && query.trim().length >= 2 && results.length === 0 && (
                        <div className="text-center py-16 animate-fade-in">
                            <p className="text-4xl mb-3">🤷</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200">No results found for "{query}"</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Try different keywords or connect more sources.</p>
                        </div>
                    )}

                    {Object.entries(errors).filter(([key, value]) => key !== 'global' && value === 'AUTH_EXPIRED').length > 0 && (
                        <div className="text-sm text-red-800 dark:text-red-200 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl px-4 py-3 flex items-center justify-between animate-slide-up">
                            <span>
                                🔒 Session expired for:{' '}
                                <strong>
                                    {Object.entries(errors)
                                        .filter(([key, value]) => key !== 'global' && value === 'AUTH_EXPIRED')
                                        .map(([key]) => key.charAt(0).toUpperCase() + key.slice(1))
                                        .join(', ')}
                                </strong>
                                . Please reconnect in Settings.
                            </span>
                            <button
                                type="button"
                                onClick={openSettings}
                                className="ml-3 bg-red-600 hover:bg-red-700 text-white text-xs px-3 py-1.5 rounded-md font-medium shrink-0 transition-colors"
                            >
                                Open Settings
                            </button>
                        </div>
                    )}
                    {Object.entries(errors).filter(([key, value]) => key !== 'global' && value && value !== 'AUTH_EXPIRED').length > 0 && (
                        <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl px-4 py-2.5 animate-slide-up">
                            ⚠️ Some sources had errors:{' '}
                            {Object.entries(errors)
                                .filter(([key, value]) => key !== 'global' && value && value !== 'AUTH_EXPIRED')
                                .map(([key, value]) => `${key}: ${value}`)
                                .join(' | ')}
                        </div>
                    )}

                    {errors.global && (
                        <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl px-4 py-3 animate-slide-up">
                            {errors.global}
                        </div>
                    )}
                </main>
            </div>

            {/* DRAGGABLE SPLITTER — resize left vs right; double-click resets */}
            {isRightPanelOpen && (
                <div
                    onMouseDown={() => setIsDragging(true)}
                    onDoubleClick={() => setLeftWidthPct(55)}
                    title="Drag to resize · double-click to reset"
                    className="relative shrink-0 w-1.5 cursor-col-resize bg-slate-200 dark:bg-slate-800 hover:bg-indigo-400 dark:hover:bg-indigo-500 transition-colors"
                >
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-10 rounded-full bg-slate-400 dark:bg-slate-600 pointer-events-none" />
                </div>
            )}

            {/* While dragging, a full-window overlay captures the mouse so the
                <webview> (a native layer) can't swallow mousemove/mouseup. */}
            {isDragging && (
                <div
                    className="fixed inset-0 z-50"
                    style={{ cursor: 'col-resize' }}
                    onMouseMove={onDividerDrag}
                    onMouseUp={() => setIsDragging(false)}
                    onMouseLeave={() => setIsDragging(false)}
                />
            )}

            {/* RIGHT COLUMN — Slack webview panel */}
            {isSlackPanelOpen && (
                <div
                    className="relative border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col"
                    style={{ flex: '1 1 auto', minWidth: '300px' }}
                >
                    {/* Panel header */}
                    <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider">Slack</span>
                        <button
                            type="button"
                            onClick={handleCloseSlackPanel}
                            className="text-slate-400 hover:text-red-500 text-sm leading-none px-1"
                            title="Close Slack panel"
                        >
                            ✕
                        </button>
                    </div>
                    {/* Electron webview — loads Slack's canonical permalink URL
                        (e.g. https://{workspace}.slack.com/archives/{channel}/p{ts}).
                        Slack's own server handles the redirect into the SPA at the
                        correct channel + message. Constructing /client/{teamId}/...
                        ourselves is unreliable for Enterprise Grid because the team
                        ID exposed via boot_data is the E-prefixed enterprise org. */}
                    <webview
                        key={slackKey}
                        ref={webviewRef}
                        src={slackPanelUrl}
                        partition="persist:perfectsearch-slack"
                        useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
                        style={{ flex: '1 1 auto', width: '100%', height: '100%' }}
                    />
                </div>
            )}

            {/* RIGHT COLUMN — embedded ServiceNow agent UI.
                Same partition as the connector, so it's already authenticated.
                Full agent UI with free navigation (home, dashboards, cases, KB). */}
            {isSnowPanelOpen && (
                <div
                    className="relative border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col h-full overflow-hidden"
                    style={{ flex: '1 1 auto', minWidth: '300px' }}
                >
                    <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider">ServiceNow</span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleAnalyzeCase}
                                disabled={analyzeStatus === 'streaming'}
                                className="text-xs px-2.5 py-1 rounded-md font-medium bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900 disabled:opacity-50 transition-colors"
                                title="Read the open case (description, comments, screenshots) and produce a summary + likely root cause + troubleshooting steps"
                            >
                                {analyzeStatus === 'streaming' ? '✨ Analyzing…' : '✨ Analyze case'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { const wv = snowWebviewRef.current; if (wv) { try { wv.reload(); } catch (_) { /* ignore */ } } }}
                                className="text-slate-400 hover:text-indigo-500 text-sm leading-none px-1"
                                title="Reload ServiceNow"
                            >
                                ⟳
                            </button>
                            <button
                                type="button"
                                onClick={() => { const wv = snowWebviewRef.current; if (wv) { try { window.perfectsearch.openLink(wv.getURL()); } catch (_) { /* ignore */ } } }}
                                className="text-slate-400 hover:text-indigo-500 text-sm leading-none px-1"
                                title="Open current page in your browser"
                            >
                                ↗
                            </button>
                            <button
                                type="button"
                                onClick={handleCloseSnowPanel}
                                className="text-slate-400 hover:text-red-500 text-sm leading-none px-1"
                                title="Close ServiceNow panel"
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                    <div className="relative" style={{ flex: '1 1 auto', minHeight: 0 }}>
                        <webview
                            key="snow-webview"
                            ref={snowWebviewRef}
                            src={snowUrl}
                            partition="persist:perfectsearch-servicenow"
                            useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
                            allowpopups="true"
                            // A <webview> is a separate native compositing layer that
                            // punches through semi-transparent DOM overlays, so hide it
                            // only while real analysis CONTENT is showing (streaming /
                            // done). For the 'error' state (e.g. "no case open") we keep
                            // the webview visible so the user can navigate to a case —
                            // the error renders as a small dismissible banner instead.
                            style={{ width: '100%', height: '100%', display: (analyzeStatus === 'streaming' || analyzeStatus === 'done') ? 'none' : 'flex' }}
                        />

                        {/* Error (e.g. "no case open") — a compact dismissible banner
                            laid OVER the still-visible webview, so the user can navigate
                            to a case and retry without losing the ServiceNow view. */}
                        {analyzeStatus === 'error' && (
                            <div className="absolute top-0 left-0 right-0 z-10 m-3 animate-fade-in">
                                <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-950/80 backdrop-blur border border-amber-300 dark:border-amber-800 rounded-xl px-4 py-3 shadow-lg">
                                    <span className="text-base shrink-0">⚠️</span>
                                    <p className="flex-1 text-sm text-amber-900 dark:text-amber-200">{analyzeError || 'Analysis failed.'}</p>
                                    <button
                                        type="button"
                                        onClick={closeAnalyze}
                                        className="text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 text-sm leading-none px-1 shrink-0"
                                        title="Dismiss"
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* AI case-analysis result — replaces the (hidden) webview while
                            streaming or done. Fully opaque so the ServiceNow page can't
                            bleed through. */}
                        {(analyzeStatus === 'streaming' || analyzeStatus === 'done') && (
                            <div className="absolute inset-0 bg-white dark:bg-slate-900 flex flex-col animate-fade-in">
                                <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-base">✨</span>
                                        <span className="font-bold text-sm bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent">
                                            Case Analysis{analyzeMeta?.caseNumber ? ` — ${analyzeMeta.caseNumber}` : ''}
                                        </span>
                                        {analyzeStatus === 'streaming' && (
                                            <span className="text-[10px] uppercase tracking-wider text-indigo-600 dark:text-indigo-400 font-semibold animate-pulse">analyzing…</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {analyzeStatus === 'done' && analyzeText && (
                                            <button
                                                type="button"
                                                onClick={() => { try { navigator.clipboard.writeText(analyzeText); } catch (_) { /* ignore */ } }}
                                                className="text-xs px-2 py-1 rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 font-medium"
                                                title="Copy analysis"
                                            >
                                                Copy
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={closeAnalyze}
                                            className="text-slate-400 hover:text-red-500 text-sm leading-none px-1"
                                            title="Close analysis"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
                                    {analyzeStatus === 'error' ? (
                                        <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl px-4 py-3">
                                            {analyzeError || 'Analysis failed.'}
                                        </div>
                                    ) : (
                                        <>
                                            {analyzeText
                                                ? renderMarkdown(analyzeText, onAnalyzeCitation)
                                                : <p className="text-slate-500 dark:text-slate-400">Reading the case, comments, screenshots and knowledge base…</p>}

                                            {/* Clickable source list behind the [N] citations */}
                                            {analyzeStatus === 'done' && analyzeMeta && analyzeMeta.sources && analyzeMeta.sources.length > 0 && (
                                                <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
                                                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Sources</p>
                                                    <ol className="space-y-1">
                                                        {analyzeMeta.sources.map((s) => (
                                                            <li key={s.n} className="text-xs text-slate-600 dark:text-slate-300 flex gap-1.5">
                                                                <span className="font-bold text-indigo-600 dark:text-indigo-400 shrink-0">[{s.n}]</span>
                                                                {s.link ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => onAnalyzeCitation(s.n)}
                                                                        className="text-left hover:underline text-indigo-700 dark:text-indigo-300"
                                                                        title={s.link}
                                                                    >
                                                                        {s.title} <span className="text-slate-400">· {s.source}{s.type ? ` (${s.type})` : ''}</span>
                                                                    </button>
                                                                ) : (
                                                                    <span>{s.title} <span className="text-slate-400">· {s.source}</span></span>
                                                                )}
                                                            </li>
                                                        ))}
                                                    </ol>
                                                </div>
                                            )}

                                            {analyzeStatus === 'done' && analyzeMeta && (
                                                <p className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500">
                                                    Read {analyzeMeta.taskCount || 0} related record(s) · {analyzeMeta.attachmentCount || 0} attachment(s) · {analyzeMeta.imagesRead || 0} screenshot(s) · {analyzeMeta.textFilesRead || 0} file(s) · {analyzeMeta.kbCount || 0} knowledge-base reference(s){analyzeMeta.model ? ` · ${analyzeMeta.provider || ''}/${analyzeMeta.model}` : ''}
                                                </p>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
