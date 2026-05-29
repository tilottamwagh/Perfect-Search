function safeJsonParse(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
}

function truncateText(value, limit = 200) {
    if (!value) {
        return '';
    }

    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

module.exports = {
    safeJsonParse,
    truncateText,
};
