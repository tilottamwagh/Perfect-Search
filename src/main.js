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

function createMainWindow() {
  const icon = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    title: process.env.APP_NAME || 'PerfectSearch',
    backgroundColor: '#f8fafc',
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

  logger.success('Phase 5', 'Main window created');
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
