require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell, nativeImage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

// Register `app://` as a privileged scheme so the renderer can <img src="app://brain.png">
// pull files straight out of the project's assets/ directory at runtime, without
// dragging static files through webpack. This must happen before app.whenReady().
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);
const { loginSlack, loginConfluence, loginServiceNow, loginAtlassian, loginBox, loginJira, loginResources, loginDatadog, loginAws, clearPersistentWindow } = require('./auth/session');
const tokenStore = require('./auth/tokenStore');
const { search, clearCache } = require('./search/engine');
const { buildIndex } = require('./connectors/website');
const logger = require('./utils/logger');

if (require('electron-squirrel-startup')) {
  app.quit();
}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Resolve the OS-level window/taskbar icon. Electron's BrowserWindow.icon
// requires a raster image (.ico / .png). The SVG brand mark in assets/ is
// used everywhere in-app; for the taskbar we look for a packaged PNG/ICO
// next to it. Drop assets/icon.png (256x256+ recommended) — or icon.ico on
// Windows — to give the title bar / dock / taskbar the proper artwork.
function resolveAppIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    path.join(process.cwd(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    path.join(process.cwd(), 'assets', 'icon.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch (_) {}
  }
  return null;
}

let mainWindow = null;
let splashWindow = null;

// Inline splash content — frameless, centered, dark-themed window that bridges
// the gap between app launch and React's first paint. Branded with the Shri
// Yantra mark, cycles through status messages, shows an animated progress bar
// and a soft "opening in N…" countdown. We render it from a data: URL so it
// doesn't require any extra file in the packaged asar.
function buildSplashHtml() {
  const css = `
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-app-region:drag;cursor:default;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif}
    body{display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 30% 20%,#1e1b4b 0%,#0b1228 60%,#080d1f 100%);color:#fef3c7;position:relative}
    body::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 70% 80%,rgba(251,191,36,.18) 0%,transparent 50%);pointer-events:none}
    .wrap{position:relative;display:flex;flex-direction:column;align-items:center;gap:18px;padding:32px;text-align:center;animation:fadeIn .6s ease}
    @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
    @keyframes pulse{0%,100%{opacity:.7;transform:scale(1)}50%{opacity:1;transform:scale(1.05)}}
    .logo{width:128px;height:128px;animation:pulse 2.4s ease-in-out infinite;filter:drop-shadow(0 4px 24px rgba(251,191,36,.35))}
    .title{font-size:34px;font-weight:800;letter-spacing:-.5px;background:linear-gradient(90deg,#fde047,#fbbf24,#f59e0b);-webkit-background-clip:text;background-clip:text;color:transparent;margin-top:4px}
    .subtitle{font-size:12px;color:#a5b4fc;letter-spacing:1.5px;text-transform:uppercase;font-weight:600}
    .status{font-size:13px;color:#cbd5e1;height:18px;transition:opacity .3s;font-variant-numeric:tabular-nums}
    .bar{width:280px;height:4px;background:rgba(167,139,250,.18);border-radius:99px;overflow:hidden;margin-top:4px}
    .fill{height:100%;background:linear-gradient(90deg,#a78bfa,#22d3ee,#fde047);border-radius:99px;width:0%;transition:width .35s ease;box-shadow:0 0 12px rgba(34,211,238,.45)}
    .countdown{font-size:11px;color:#94a3b8;margin-top:6px;font-weight:500;letter-spacing:.3px}
    .version{position:absolute;bottom:14px;right:18px;font-size:10px;color:#64748b;letter-spacing:.5px;font-weight:500}
  `;

  // Compact inline SVG of the Shri Yantra brand mark — same geometry as
  // assets/logo.svg, simplified for splash-size readability.
  const svg = `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" class="logo" shape-rendering="geometricPrecision">
    <defs>
      <linearGradient id="sbg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#0a0f25"/><stop offset="1" stop-color="#080d1f"/>
      </linearGradient>
      <radialGradient id="shalo" cx="0.5" cy="0.5" r="0.55">
        <stop offset="0" stop-color="#fde047" stop-opacity="0.45"/><stop offset="1" stop-color="#fbbf24" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="sbindu" cx="0.45" cy="0.4" r="0.6">
        <stop offset="0" stop-color="#fef3c7"/><stop offset="0.4" stop-color="#fbbf24"/><stop offset="1" stop-color="#b45309"/>
      </radialGradient>
      <linearGradient id="sgold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fde047"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="22" fill="url(#sbg)"/>
    <circle cx="64" cy="64" r="46" fill="url(#shalo)"/>
    <g fill="none" stroke="url(#sgold)" stroke-width="0.9" stroke-opacity="0.85">
      <rect x="12" y="12" width="104" height="104" rx="2"/>
      <path d="M58 12 L58 7 L70 7 L70 12"/><path d="M58 116 L58 121 L70 121 L70 116"/>
      <path d="M12 58 L7 58 L7 70 L12 70"/><path d="M116 58 L121 58 L121 70 L116 70"/>
    </g>
    <circle cx="64" cy="64" r="26" fill="none" stroke="#fde047" stroke-width="0.7" stroke-opacity="0.8"/>
    <g fill="none" stroke="url(#sgold)" stroke-width="0.8" stroke-opacity="0.9">
      <polygon points="64,42 39,86 89,86" fill="#fbbf24" fill-opacity="0.07"/>
      <polygon points="64,48 45,82 83,82" fill="#fbbf24" fill-opacity="0.07"/>
      <polygon points="64,54 51,78 77,78" fill="#fbbf24" fill-opacity="0.07"/>
    </g>
    <g fill="none" stroke="#22d3ee" stroke-width="0.8" stroke-opacity="0.9">
      <polygon points="64,86 39,42 89,42" fill="#22d3ee" fill-opacity="0.07"/>
      <polygon points="64,80 44,46 84,46" fill="#22d3ee" fill-opacity="0.07"/>
      <polygon points="64,74 50,50 78,50" fill="#22d3ee" fill-opacity="0.07"/>
    </g>
    <circle cx="64" cy="64" r="3" fill="url(#sbindu)"/>
    <circle cx="64" cy="64" r="1.1" fill="#fef3c7"/>
  </svg>`;

  const messages = [
    'Warming up the AI brain…',
    'Loading enterprise connectors…',
    'Initializing search engine…',
    'Preparing your dashboard…',
    'Almost ready…',
  ];

  const js = `
    const messages = ${JSON.stringify(messages)};
    const status = document.getElementById('status');
    const fill = document.getElementById('fill');
    const countdown = document.getElementById('countdown');
    let idx = 0, secs = 5, pct = 0;
    function tick(){
      status.style.opacity = 0;
      setTimeout(()=>{ status.textContent = messages[idx]; status.style.opacity = 1; idx = (idx+1)%messages.length; }, 200);
    }
    function step(){
      pct = Math.min(95, pct + 18 + Math.random()*8);
      fill.style.width = pct + '%';
    }
    function countDown(){
      if(secs > 0){
        countdown.textContent = 'Opening dashboard in ' + secs + 's…';
        secs--;
      } else {
        countdown.textContent = 'Opening dashboard…';
      }
    }
    tick(); step(); countDown();
    setInterval(tick, 850);
    setInterval(step, 700);
    setInterval(countDown, 1000);
  `;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <div class="wrap">
      ${svg}
      <div class="title">PerfectSearch</div>
      <div class="subtitle">Unified Enterprise Search</div>
      <div class="status" id="status">Starting…</div>
      <div class="bar"><div class="fill" id="fill"></div></div>
      <div class="countdown" id="countdown">Opening dashboard in 5s…</div>
    </div>
    <div class="version">v${app.getVersion ? app.getVersion() : ''}</div>
    <script>${js}<\/script>
  </body></html>`;

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 360,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#080d1f',
    center: true,
    show: true,
    alwaysOnTop: true,
    title: 'PerfectSearch',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.removeMenu();
  splashWindow.loadURL(buildSplashHtml());
  splashWindow.on('closed', () => { splashWindow = null; });
  logger.info('Phase 5', 'Splash window shown');
}

function createMainWindow() {
  const icon = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    title: process.env.APP_NAME || 'PerfectSearch',
    backgroundColor: '#0b1228',
    show: false, // ← stays hidden until React paints; prevents the blank-flash
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // ready-to-show fires after the renderer's first paint — that's the right
  // moment to swap from splash to the real window. Guarantee a small minimum
  // splash duration (1.2s) so the brand-mark animation doesn't flash by.
  const minSplashUntil = Date.now() + 1200;
  let revealed = false;
  const reveal = () => {
    if (revealed || !mainWindow) return;
    revealed = true;
    const delay = Math.max(0, minSplashUntil - Date.now());
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }, delay);
  };
  mainWindow.once('ready-to-show', reveal);
  // Safety fallback — never let the splash hang forever if ready-to-show
  // somehow misses (rare but possible on cold-start webpack builds).
  setTimeout(reveal, 10000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Forward renderer-process console.log/error to main-process stdout so the
  // [webview] diagnostic messages from App.jsx land where we can read them.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levels = ['VERBOSE', 'INFO', 'WARN', 'ERROR'];
    const tag = levels[level] || 'LOG';
    // eslint-disable-next-line no-console
    console.log(`[renderer:${tag}] ${message}  (${sourceId || ''}:${line || ''})`);
  });

  logger.success('Phase 5', 'Main window created (hidden, awaiting ready-to-show)');
}

app.whenReady().then(() => {
  // Serve files from the project's assets/ folder via app://<filename>.
  // Resolves the project root for both dev (electron-forge start, where
  // __dirname is ./src) and packaged builds (__dirname is asar root).
  const ASSETS_ROOTS = [
    path.join(__dirname, '..', '..', 'assets'),
    path.join(__dirname, '..', 'assets'),
    path.join(process.cwd(), 'assets'),
  ];
  protocol.handle('app', async (request) => {
    try {
      const u = new URL(request.url);
      const requested = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+/, '');
      for (const root of ASSETS_ROOTS) {
        const filePath = path.join(root, requested);
        // Defensive: keep the resolved path inside the assets root.
        if (!filePath.startsWith(root)) continue;
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          return net.fetch(url.pathToFileURL(filePath).href);
        }
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      return new Response(`error: ${err.message}`, { status: 500 });
    }
  });

  logger.info('Phase 5', 'Electron app ready');
  // Show the branded splash immediately so the user sees something the
  // instant they double-click the app, then start building the main window
  // in the background. The main window stays hidden until React's first
  // paint (via `ready-to-show`), at which point the splash is swapped out
  // for the real dashboard.
  createSplashWindow();
  createMainWindow();

  // Block slack:// protocol links from opening the desktop app
  app.on('open-url', (event, url) => {
    if (url && url.startsWith('slack://')) {
      event.preventDefault();
    }
  });

  buildIndex().catch((error) => logger.error('Phase 5', 'Website indexing failed', error));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('auth:status', async () => tokenStore.getStatus());

ipcMain.handle('auth:login:slack', async () => {
  try {
    const data = await loginSlack();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:confluence', async () => {
  try {
    const data = await loginConfluence();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:servicenow', async () => {
  try {
    const data = await loginServiceNow();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:atlassian', async () => {
  try {
    const data = await loginAtlassian();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:box', async () => {
  try {
    const data = await loginBox();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:jira', async () => {
  try {
    const data = await loginJira();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:resources', async () => {
  try {
    const data = await loginResources();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:datadog', async () => {
  try {
    const data = await loginDatadog();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:login:aws', async () => {
  try {
    const data = await loginAws();
    clearCache();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:logout', async (_event, source) => {
  tokenStore.clear(source);
  clearPersistentWindow(source);
  clearCache();
  return { success: true };
});

// ---------- Per-connector settings (instance URLs) ----------
// Required because the packaged installer can't read .env — each user must
// enter their own ServiceNow / Confluence / etc. instance URL.

function normalizeBaseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  // Strip trailing slash and any path — we only want the origin.
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

ipcMain.handle('source:getConfig', async (_event, source) => {
  return { success: true, config: tokenStore.getSourceConfig(source) || {} };
});

ipcMain.handle('source:saveConfig', async (_event, source, config) => {
  if (!source) return { success: false, error: 'Source required' };
  const baseUrl = normalizeBaseUrl(config?.baseUrl);
  if (config?.baseUrl && !baseUrl) {
    return { success: false, error: 'Invalid URL. Use e.g. https://yourcompany.service-now.com' };
  }
  tokenStore.saveSourceConfig(source, { ...config, baseUrl });
  return { success: true, config: { ...config, baseUrl } };
});

ipcMain.handle('source:listConfigs', async () => {
  return {
    success: true,
    configs: {
      servicenow: tokenStore.getSourceConfig('servicenow') || {},
      confluence: tokenStore.getSourceConfig('confluence') || {},
      atlassian: tokenStore.getSourceConfig('atlassian') || {},
      jira: tokenStore.getSourceConfig('jira') || {},
      box: tokenStore.getSourceConfig('box') || {},
      resources: tokenStore.getSourceConfig('resources') || {},
      datadog: tokenStore.getSourceConfig('datadog') || {},
      aws: tokenStore.getSourceConfig('aws') || {},
      website: tokenStore.getSourceConfig('website') || {},
    },
  };
});

ipcMain.handle('search:query', async (_event, { query, options }) => {
  try {
    return { success: true, data: await search(query, options) };
  } catch (error) {
    logger.error('Phase 8', 'Search IPC error', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('search:clearCache', async () => {
  clearCache();
  return { success: true };
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (url) {
    await shell.openExternal(url);
  }
  return { success: true };
});

ipcMain.handle('slack-panel:open', async (_event, url) => {
  if (url && mainWindow) {
    mainWindow.webContents.send('slack-panel:opened', url);
  }
  return { success: true };
});

ipcMain.handle('website:reindex', async () => {
  try {
    await buildIndex(true);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ---------- AI ----------

ipcMain.handle('ai:providers', async () => {
  const ai = require('./ai');
  return {
    providers: ai.listProviders(),
    active: ai.resolveActiveProvider(),
  };
});

ipcMain.handle('ai:saveKey', async (_event, providerId, apiKey, modelId) => {
  if (!providerId || !apiKey || typeof apiKey !== 'string' || apiKey.length < 20) {
    return { success: false, error: 'Provider and API key required' };
  }
  try {
    const ai = require('./ai');
    const probe = await ai.testKey(providerId, apiKey.trim());
    if (!probe.ok) return { success: false, error: probe.error || 'Key did not respond OK' };
    tokenStore.saveAiKey(providerId, apiKey.trim());
    if (modelId) tokenStore.saveAiModel(providerId, modelId);
    if (!tokenStore.getActiveAiProvider()) tokenStore.setActiveAiProvider(providerId);
    return { success: true, model: modelId || probe.model };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai:saveModel', async (_event, providerId, modelId) => {
  if (!providerId) return { success: false, error: 'Provider required' };
  tokenStore.saveAiModel(providerId, modelId);
  return { success: true };
});

ipcMain.handle('ai:clearKey', async (_event, providerId) => {
  tokenStore.clearAiKey(providerId);
  // If the cleared provider was active, fall back to the next configured one.
  if (tokenStore.getActiveAiProvider() === providerId) {
    const ai = require('./ai');
    const next = ai.resolveActiveProvider();
    tokenStore.setActiveAiProvider(next);
  }
  return { success: true };
});

ipcMain.handle('ai:setActive', async (_event, providerId) => {
  if (providerId && !tokenStore.hasAiKey(providerId)) {
    return { success: false, error: 'No key configured for that provider' };
  }
  tokenStore.setActiveAiProvider(providerId);
  return { success: true };
});

ipcMain.handle('ai:synthesize', async (event, { requestId, query, results }) => {
  try {
    const ai = require('./ai');
    const channel = `ai:chunk:${requestId}`;
    const result = await ai.synthesize({
      query,
      results,
      onChunk: (delta) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, delta);
      },
    });
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ai:synthesizeWeb', async (event, { requestId, query }) => {
  try {
    const ai = require('./ai');
    const channel = `ai:chunk:${requestId}`;
    const result = await ai.synthesizeWithWeb({
      query,
      onChunk: (delta) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, delta);
      },
    });
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
