require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { loginSlack, loginConfluence, loginServiceNow, loginAtlassian, loginBox, loginJira, clearPersistentWindow } = require('./auth/session');
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

ipcMain.handle('auth:logout', async (_event, source) => {
  tokenStore.clear(source);
  clearPersistentWindow(source);
  clearCache();
  return { success: true };
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
