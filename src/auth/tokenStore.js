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
};

module.exports = TokenStore;
