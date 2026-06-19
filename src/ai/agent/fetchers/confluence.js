const axios = require('axios');
const tokenStore = require('../../../auth/tokenStore');
const logger = require('../../../utils/logger');
const { cleanHtml } = require('../extractor');

// Fetch the full body of a Confluence page using the user's existing SSO
// cookie session. The page ID is either:
//   (a) stored in result.extras['Content ID'] (what the connector saves)
//   (b) embedded in the URL as /pages/{id}/ (matches the canonical link)
// If neither yields a usable ID we return null and the synthesizer falls
// back to the snippet.

const PAGE_ID_PATTERNS = [
    /\/pages\/(\d+)(?:\/|$|\?|#)/,        // /spaces/X/pages/12345/Title
    /pageId=(\d+)/,                        // legacy ?pageId=12345
    /\/wiki\/x\/([A-Za-z0-9_-]+)/,         // tiny URL — content ID is base64 encoded
];

function extractPageId(link, extras) {
    if (extras && typeof extras['Content ID'] === 'string' && /^\d+$/.test(extras['Content ID'])) {
        return extras['Content ID'];
    }
    if (typeof link !== 'string') return null;
    for (const re of PAGE_ID_PATTERNS) {
        const m = link.match(re);
        if (m && m[1]) {
            // tiny-URL form needs base64 decode then int
            if (re.source.includes('x/')) {
                try {
                    const padded = m[1] + '=='.slice(0, (4 - (m[1].length % 4)) % 4);
                    const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
                    // Decoded is a varint — read as a hex sequence and parse the first BigInt.
                    return BigInt('0x' + decoded.toString('hex')).toString();
                } catch (_) { return null; }
            }
            return m[1];
        }
    }
    return null;
}

async function fetchConfluence(result, { maxChars = 4096, timeoutMs = 5000 } = {}) {
    const tokens = tokenStore.get('confluence');
    if (!tokens || !tokens.cookieHeader) return null;

    const pageId = extractPageId(result.link, result.extras);
    if (!pageId) {
        logger.info('Phase 6', `[fetch:confluence] no page ID in ${result.link} — skipping`);
        return null;
    }

    const baseUrl = tokens.baseUrl || process.env.CONFLUENCE_BASE_URL;
    if (!baseUrl) return null;

    const url = `${baseUrl}/wiki/rest/api/content/${pageId}`;
    try {
        const resp = await axios.get(url, {
            params: { expand: 'body.storage,space,version' },
            headers: {
                Cookie: tokens.cookieHeader,
                'X-Atlassian-Token': 'no-check',
                Accept: 'application/json',
            },
            timeout: timeoutMs,
        });
        const data = resp.data || {};
        const storage = data.body?.storage?.value || '';
        if (!storage) return null;

        const text = cleanHtml(storage, { maxChars });
        logger.info('Phase 6', `[fetch:confluence] ${pageId} → ${text.length} chars`);
        return {
            fullContent: text,
            metadata: {
                space: data.space?.name || null,
                version: data.version?.number ?? null,
                lastModified: data.version?.when || null,
            },
        };
    } catch (err) {
        logger.warn('Phase 6', `[fetch:confluence] ${pageId} failed: ${err.message}`);
        return null;
    }
}

module.exports = { fetchConfluence, extractPageId };
