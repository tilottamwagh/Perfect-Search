const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('electron-store', () => {
    const store = {};

    return jest.fn().mockImplementation(() => ({
        set: (key, value) => {
            store[key] = value;
        },
        get: (key) => store[key],
        delete: (key) => {
            delete store[key];
        },
        clear: () => {
            Object.keys(store).forEach((key) => delete store[key]);
        },
    }));
});

const tokenStore = require('../src/auth/tokenStore');

describe('TokenStore', () => {
    beforeEach(() => tokenStore.clearAll());

    it('saves and retrieves tokens', () => {
        tokenStore.save('slack', { token: 'xoxs-test' });
        const data = tokenStore.get('slack');

        expect(data.token).toBe('xoxs-test');
        expect(data.savedAt).toBeDefined();
    });

    it('detects valid sessions', () => {
        tokenStore.save('slack', { token: 'test' });
        expect(tokenStore.isValid('slack')).toBe(true);
    });

    it('returns false for missing sessions', () => {
        expect(tokenStore.isValid('confluence')).toBe(false);
    });

    it('clears individual sources', () => {
        tokenStore.save('slack', { token: 'test' });
        tokenStore.clear('slack');
        expect(tokenStore.get('slack')).toBe(null);
    });

    it('returns status for all sources', () => {
        tokenStore.save('slack', { token: 'test' });
        const status = tokenStore.getStatus();

        expect(status.slack).toBe(true);
        expect(status.confluence).toBe(false);
    });
});
