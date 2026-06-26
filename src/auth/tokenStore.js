require('dotenv').config();
const Store = require('electron-store');
const logger = require('../utils/logger');

const store = new Store({
    name: 'perfectsearch-tokens',
    encryptionKey: process.env.ENCRYPTION_KEY || 'fallback-key-set-env',
    clearInvalidConfig: true,
});

const TokenStore = {
    save(source, tokens) {
        store.set(`auth.${source}`, {
            ...tokens,
            savedAt: new Date().toISOString(),
        });

        logger.success('Phase 2', `Saved tokens for ${source}`);
    },

    get(source) {
        return store.get(`auth.${source}`) || null;
    },

    isValid(source) {
        const data = this.get(source);
        if (!data || !data.savedAt) {
            return false;
        }

        const hours = Number(process.env.SESSION_REFRESH_HOURS || 8);
        const ageMs = Date.now() - new Date(data.savedAt).getTime();
        return ageMs < hours * 60 * 60 * 1000;
    },

    clear(source) {
        store.delete(`auth.${source}`);
        logger.info('Phase 2', `Cleared tokens for ${source}`);
    },

    clearAll() {
        store.clear();
        logger.info('Phase 2', 'Cleared all tokens');
    },

    getStatus() {
        return {
            slack: this.isValid('slack'),
            confluence: this.isValid('confluence'),
            servicenow: this.isValid('servicenow'),
            atlassian: this.isValid('atlassian'),
            box: this.isValid('box'),
            jira: this.isValid('jira'),
            resources: this.isValid('resources'),
            datadog: this.isValid('datadog'),
            aws: this.isValid('aws'),
        };
    },

    // Multi-provider AI keys. Each provider (anthropic, gemini, openai, etc.)
    // gets its own slot. Users can have several configured and pick which to
    // use as the "active" one via `setActiveAiProvider`.
    saveAiKey(providerId, apiKey) {
        store.set(`ai.${providerId}.apiKey`, apiKey);
        store.set(`ai.${providerId}.savedAt`, new Date().toISOString());
    },

    getAiKey(providerId) {
        return store.get(`ai.${providerId}.apiKey`) || null;
    },

    hasAiKey(providerId) {
        return Boolean(store.get(`ai.${providerId}.apiKey`));
    },

    clearAiKey(providerId) {
        store.delete(`ai.${providerId}.apiKey`);
        store.delete(`ai.${providerId}.savedAt`);
    },

    setActiveAiProvider(providerId) {
        if (providerId) store.set('ai.active', providerId);
        else store.delete('ai.active');
    },

    getActiveAiProvider() {
        return store.get('ai.active') || null;
    },

    // Per-provider model selection. Falls back to the adapter's defaultModel
    // when the user hasn't explicitly picked one.
    saveAiModel(providerId, modelId) {
        if (modelId) store.set(`ai.${providerId}.model`, modelId);
        else store.delete(`ai.${providerId}.model`);
    },

    getAiModel(providerId) {
        return store.get(`ai.${providerId}.model`) || null;
    },

    // Per-provider reasoning effort (minimal/low/medium/high). Only meaningful
    // for OpenAI gpt-5 + o-series reasoning models; ignored by other models.
    saveAiReasoning(providerId, level) {
        if (level) store.set(`ai.${providerId}.reasoning`, level);
        else store.delete(`ai.${providerId}.reasoning`);
    },

    getAiReasoning(providerId) {
        return store.get(`ai.${providerId}.reasoning`) || null;
    },

    // Per-connector configuration (instance URLs, etc.). Needed because the
    // packaged installer can't read a .env file — each user has their own
    // ServiceNow / Confluence instance and must enter it in Settings.
    saveSourceConfig(source, config) {
        if (!source || !config) return;
        store.set(`config.${source}`, config);
        logger.info('Phase 2', `Saved config for ${source}`);
    },

    getSourceConfig(source) {
        return store.get(`config.${source}`) || null;
    },

    getSourceUrl(source) {
        const cfg = store.get(`config.${source}`) || {};
        return cfg.baseUrl || null;
    },

    clearSourceConfig(source) {
        store.delete(`config.${source}`);
    },
};

module.exports = TokenStore;
