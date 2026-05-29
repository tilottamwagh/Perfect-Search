const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('perfectsearch', {
    getAuthStatus: () => ipcRenderer.invoke('auth:status'),
    loginSlack: () => ipcRenderer.invoke('auth:login:slack'),
    loginConfluence: () => ipcRenderer.invoke('auth:login:confluence'),
    loginServiceNow: () => ipcRenderer.invoke('auth:login:servicenow'),
    loginAtlassian: () => ipcRenderer.invoke('auth:login:atlassian'),
    loginBox: () => ipcRenderer.invoke('auth:login:box'),
    loginJira: () => ipcRenderer.invoke('auth:login:jira'),
    logout: (source) => ipcRenderer.invoke('auth:logout', source),
    search: (query, options) => ipcRenderer.invoke('search:query', { query, options }),
    clearCache: () => ipcRenderer.invoke('search:clearCache'),
    openLink: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openSlackInPanel: (url) => ipcRenderer.invoke('slack-panel:open', url),
    onSlackPanelOpened: (callback) => {
        const handler = (_event, url) => callback(url);
        ipcRenderer.on('slack-panel:opened', handler);
        return () => ipcRenderer.removeListener('slack-panel:opened', handler);
    },
    reindexWebsite: () => ipcRenderer.invoke('website:reindex'),

    // AI
    getAiProviders: () => ipcRenderer.invoke('ai:providers'),
    saveAiKey: (providerId, apiKey, modelId) => ipcRenderer.invoke('ai:saveKey', providerId, apiKey, modelId),
    saveAiModel: (providerId, modelId) => ipcRenderer.invoke('ai:saveModel', providerId, modelId),
    clearAiKey: (providerId) => ipcRenderer.invoke('ai:clearKey', providerId),
    setActiveAiProvider: (providerId) => ipcRenderer.invoke('ai:setActive', providerId),
    aiSynthesize: (requestId, query, results, onChunk) => {
        const channel = `ai:chunk:${requestId}`;
        const handler = (_event, delta) => {
            try { onChunk(delta); } catch (_) {}
        };
        ipcRenderer.on(channel, handler);
        return ipcRenderer.invoke('ai:synthesize', { requestId, query, results })
            .finally(() => ipcRenderer.removeListener(channel, handler));
    },
    aiSynthesizeWeb: (requestId, query, onChunk) => {
        const channel = `ai:chunk:${requestId}`;
        const handler = (_event, delta) => {
            try { onChunk(delta); } catch (_) {}
        };
        ipcRenderer.on(channel, handler);
        return ipcRenderer.invoke('ai:synthesizeWeb', { requestId, query })
            .finally(() => ipcRenderer.removeListener(channel, handler));
    },
});
