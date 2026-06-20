require('dotenv').config();
const Store = require('electron-store');
const logger = require('../../utils/logger');

// Persistent store for "Ask AI Expert" conversation threads. Separate file from
// the token store. Encrypted with the same key since threads can contain case
// data, logs, and customer details.
const store = new Store({
    name: 'perfectsearch-expert',
    encryptionKey: process.env.ENCRYPTION_KEY || 'fallback-key-set-env',
    clearInvalidConfig: true,
});

function allThreads() {
    return store.get('threads') || {};
}

function persist(threads) {
    store.set('threads', threads);
}

function newId() {
    return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const ThreadStore = {
    // Lightweight summaries for the thread list (no message bodies).
    list() {
        const threads = allThreads();
        return Object.values(threads)
            .map((t) => ({
                id: t.id,
                title: t.title,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
                messageCount: (t.messages || []).length,
            }))
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },

    get(id) {
        return allThreads()[id] || null;
    },

    create({ title, messages } = {}) {
        const now = new Date().toISOString();
        const thread = {
            id: newId(),
            title: title || 'New conversation',
            createdAt: now,
            updatedAt: now,
            messages: Array.isArray(messages) ? messages : [],
        };
        const threads = allThreads();
        threads[thread.id] = thread;
        persist(threads);
        logger.info('Phase 8', `Expert thread created: ${thread.id}`);
        return thread;
    },

    appendMessage(id, message) {
        const threads = allThreads();
        const thread = threads[id];
        if (!thread) return null;
        thread.messages = thread.messages || [];
        thread.messages.push({ ...message, ts: message.ts || new Date().toISOString() });
        thread.updatedAt = new Date().toISOString();
        // Auto-title from the first user message if still default.
        if ((thread.title === 'New conversation' || !thread.title) && message.role === 'user' && message.content) {
            const text = typeof message.content === 'string' ? message.content : '';
            if (text.trim()) thread.title = text.trim().slice(0, 60);
        }
        persist(threads);
        return thread;
    },

    update(id, patch) {
        const threads = allThreads();
        const thread = threads[id];
        if (!thread) return null;
        Object.assign(thread, patch, { updatedAt: new Date().toISOString() });
        persist(threads);
        return thread;
    },

    remove(id) {
        const threads = allThreads();
        if (threads[id]) {
            delete threads[id];
            persist(threads);
            logger.info('Phase 8', `Expert thread deleted: ${id}`);
            return true;
        }
        return false;
    },
};

module.exports = ThreadStore;
