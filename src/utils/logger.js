const isDev = process.env.NODE_ENV !== 'production';

const logger = {
    info: (phase, msg, data) => {
        if (isDev) {
            console.log(`\x1b[36m[${phase}]\x1b[0m`, msg, data ?? '');
        }
    },
    error: (phase, msg, err) => console.error(`\x1b[31m[${phase} ERROR]\x1b[0m`, msg, err?.message ?? err),
    warn: (phase, msg) => {
        if (isDev) {
            console.warn(`\x1b[33m[${phase} WARN]\x1b[0m`, msg);
        }
    },
    success: (phase, msg) => console.log(`\x1b[32m[${phase} ✓]\x1b[0m`, msg),
};

module.exports = logger;
