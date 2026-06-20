const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('perfectsearch', {
    getAuthStatus: () => ipcRenderer.invoke('auth:status'),
    loginSlack: () => ipcRenderer.invoke('auth:login:slack'),
    loginConfluence: () => ipcRenderer.invoke('auth:login:confluence'),
    loginServiceNow: () => ipcRenderer.invoke('auth:login:servicenow'),
    loginAtlassian: () => ipcRenderer.invoke('auth:login:atlassian'),
    loginBox: () => ipcRenderer.invoke('auth:login:box'),
    loginJira: () => ipcRenderer.invoke('auth:login:jira'),
    loginResources: () => ipcRenderer.invoke('auth:login:resources'),
    loginDatadog: () => ipcRenderer.invoke('auth:login:datadog'),
    loginAws: () => ipcRenderer.invoke('auth:login:aws'),
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

    // Per-connector instance URLs (ServiceNow / Confluence / etc.). Required
    // because the packaged installer has no .env file.
    getSourceConfig: (source) => ipcRenderer.invoke('source:getConfig', source),
    getSourceUrl: (source) => ipcRenderer.invoke('source:getUrl', source),
    saveSourceConfig: (source, config) => ipcRenderer.invoke('source:saveConfig', source, config),
    listSourceConfigs: () => ipcRenderer.invoke('source:listConfigs'),

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
    analyzeServiceNowCase: (requestId, url, webContentsId, onChunk) => {
        const channel = `ai:chunk:${requestId}`;
        const handler = (_event, delta) => {
            try { onChunk(delta); } catch (_) {}
        };
        ipcRenderer.on(channel, handler);
        return ipcRenderer.invoke('servicenow:analyzeCase', { requestId, url, webContentsId })
            .finally(() => ipcRenderer.removeListener(channel, handler));
    },

    // Ask AI Expert (conversational)
    expertListThreads: () => ipcRenderer.invoke('expert:listThreads'),
    expertGetThread: (id) => ipcRenderer.invoke('expert:getThread', { id }),
    expertNewThread: (opts) => ipcRenderer.invoke('expert:newThread', opts || {}),
    expertDeleteThread: (id) => ipcRenderer.invoke('expert:deleteThread', { id }),
    expertRenameThread: (id, title) => ipcRenderer.invoke('expert:renameThread', { id, title }),
    expertIndexStats: () => ipcRenderer.invoke('expert:indexStats'),
    expertClearIndex: () => ipcRenderer.invoke('expert:clearIndex'),
    expertFeedback: (rating, links) => ipcRenderer.invoke('expert:feedback', { rating, links }),
    expertSaveLearning: (payload) => ipcRenderer.invoke('expert:saveLearning', payload),
    expertBuildIndex: (requestId, onProgress) => {
        const channel = `expert:index:${requestId}`;
        const handler = (_event, p) => { try { onProgress && onProgress(p); } catch (_) {} };
        ipcRenderer.on(channel, handler);
        return ipcRenderer.invoke('expert:buildIndex', { requestId })
            .finally(() => ipcRenderer.removeListener(channel, handler));
    },
    expertSendMessage: (requestId, threadId, text, attachments, onChunk, onEvent) => {
        const chunkChannel = `ai:chunk:${requestId}`;
        const eventChannel = `expert:event:${requestId}`;
        const chunkHandler = (_event, delta) => { try { onChunk(delta); } catch (_) {} };
        const eventHandler = (_event, evt) => { try { onEvent && onEvent(evt); } catch (_) {} };
        ipcRenderer.on(chunkChannel, chunkHandler);
        ipcRenderer.on(eventChannel, eventHandler);
        return ipcRenderer.invoke('expert:sendMessage', { requestId, threadId, text, attachments })
            .finally(() => {
                ipcRenderer.removeListener(chunkChannel, chunkHandler);
                ipcRenderer.removeListener(eventChannel, eventHandler);
            });
    },
});
