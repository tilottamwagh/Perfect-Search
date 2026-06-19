// HTML → plain-text content extraction for fetched source bodies.
//
// Used by every fetcher (Confluence, ServiceNow, Jira) to turn the raw
// HTML / markup that REST APIs return into clean text the LLM can read
// without burning tokens on `<div class="...">` noise or duplicated
// navigation chrome.
//
// We use cheerio (already a dependency for the website connector) because
// it's lightweight, deterministic, and doesn't require running JS.

const cheerio = require('cheerio');

// Per-source content budget. Phase-2 sends up to 8 enriched sources per
// query, so 4 KB each keeps the total fetched payload around 32 KB —
// comfortably below any provider's context window once you account for
// the system prompt (~4 KB) and other source snippets.
const DEFAULT_MAX_CHARS = 4096;

// Selectors to strip outright before extracting text. These are pure
// chrome/decoration that REST endpoints return inline and that add zero
// information density for an LLM trying to summarise the page.
const STRIP_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'video', 'audio',
    'header', 'footer', 'nav', 'aside',
    '.confluence-information-macro',  // Confluence sidebar callout chrome
    '.toc-macro',                      // Confluence "On this page" widget
    '.expand-container > .expand-control',  // Collapsible header chrome
    '[data-macro-name="info"]',        // Info-macro chrome (keep the body)
    '.ajs-error',                       // Atlassian inline error banners
    '.servicenow-record-toolbar',      // Record-page toolbar chrome
];

// Tags whose textual content matters but should be wrapped with markdown
// formatting so the LLM doesn't lose structure (e.g., headings stay
// readable as headings, code blocks stay code-like).
function formatNode(node, $) {
    const tag = node.tagName?.toLowerCase();
    const text = $(node).text().trim();
    if (!text) return '';

    if (tag === 'h1') return `\n\n# ${text}\n`;
    if (tag === 'h2') return `\n\n## ${text}\n`;
    if (tag === 'h3') return `\n\n### ${text}\n`;
    if (tag === 'h4' || tag === 'h5' || tag === 'h6') return `\n\n#### ${text}\n`;
    if (tag === 'li') return `- ${text}\n`;
    if (tag === 'p') return `${text}\n\n`;
    if (tag === 'pre' || tag === 'code') return `\`\`\`\n${text}\n\`\`\`\n`;
    if (tag === 'blockquote') return `> ${text}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n---\n';
    return text + ' ';
}

/**
 * Clean HTML and extract its plain-text content.
 *
 * @param {string} html  Raw HTML from a REST API (Confluence storage format,
 *                       Jira ADF rendered, ServiceNow record HTML, etc.)
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  Truncate to this many chars (default 4096).
 *                                  Truncation prefers paragraph breaks.
 * @returns {string}  Cleaned plain text with light markdown structure.
 */
function cleanHtml(html, { maxChars = DEFAULT_MAX_CHARS } = {}) {
    if (!html || typeof html !== 'string') return '';

    let $;
    try {
        $ = cheerio.load(html);
    } catch (_) {
        // Not valid HTML — return as-is (already-plain text from some APIs).
        return truncate(html.trim(), maxChars);
    }

    // Strip noise
    for (const sel of STRIP_SELECTORS) {
        try { $(sel).remove(); } catch (_) { /* invalid selector — skip */ }
    }

    // Walk significant structural elements top-to-bottom and stitch their
    // text together. This preserves the natural reading order of the page.
    const STRUCTURAL_TAGS = 'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote';
    const pieces = [];
    $(STRUCTURAL_TAGS).each((_, el) => {
        const piece = formatNode(el, $);
        if (piece) pieces.push(piece);
    });

    // Fallback: if the document has no structural tags at all (rare for
    // Confluence storage format but possible for ServiceNow's plain-text
    // fields), just use the whole body text.
    let combined = pieces.length > 0
        ? pieces.join('').replace(/\n{3,}/g, '\n\n').trim()
        : $.root().text().replace(/\s+/g, ' ').trim();

    return truncate(combined, maxChars);
}

/**
 * Truncate at a paragraph or sentence boundary near `maxChars` so the
 * trailing fragment doesn't end mid-word or mid-tag-name. Adds a clear
 * "[truncated]" marker so the LLM knows there's more.
 */
function truncate(text, maxChars) {
    if (!text || text.length <= maxChars) return text;

    // Prefer the last paragraph break before maxChars.
    const sliceTo = text.slice(0, maxChars);
    const lastPara = sliceTo.lastIndexOf('\n\n');
    if (lastPara > maxChars * 0.6) {
        return sliceTo.slice(0, lastPara) + '\n\n[truncated — more content available]';
    }

    // Fall back to the last sentence-ish break.
    const lastSentence = Math.max(
        sliceTo.lastIndexOf('. '),
        sliceTo.lastIndexOf('? '),
        sliceTo.lastIndexOf('! '),
    );
    if (lastSentence > maxChars * 0.6) {
        return sliceTo.slice(0, lastSentence + 1) + ' [truncated — more content available]';
    }

    // Last resort: hard cut at the last word boundary.
    const lastSpace = sliceTo.lastIndexOf(' ');
    return sliceTo.slice(0, lastSpace > 0 ? lastSpace : maxChars) + '… [truncated]';
}

/**
 * Extract clean text from Slack-style message JSON. Slack messages aren't
 * HTML — they're JSON with embedded mrkdwn / blocks. We render the most
 * common elements: `text`, `blocks[].elements[].text`, attachment fallback.
 */
function slackMessageToText(msg) {
    if (!msg) return '';
    const parts = [];

    // 1. Main message text (mrkdwn)
    if (typeof msg.text === 'string' && msg.text.length > 0) {
        parts.push(msg.text);
    }

    // 2. Block-kit blocks (modern messages)
    if (Array.isArray(msg.blocks)) {
        for (const block of msg.blocks) {
            const blockText = extractBlockText(block);
            if (blockText && !parts.includes(blockText)) parts.push(blockText);
        }
    }

    // 3. Attachments (legacy)
    if (Array.isArray(msg.attachments)) {
        for (const att of msg.attachments) {
            if (typeof att.fallback === 'string' && att.fallback.length > 0) {
                parts.push(`[attachment] ${att.fallback}`);
            } else if (typeof att.text === 'string') {
                parts.push(`[attachment] ${att.text}`);
            }
        }
    }

    // 4. Files
    if (Array.isArray(msg.files)) {
        for (const f of msg.files) {
            if (f.name) parts.push(`[file] ${f.name}${f.title ? ' — ' + f.title : ''}`);
        }
    }

    // Resolve user mentions <@U123> and channel mentions <#C123|name>
    // into something readable.
    return parts
        .map((p) => p
            .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, name) => `@${name || id}`)
            .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, name) => `#${name || id}`)
            .replace(/<((?:https?:\/\/|mailto:)[^|>]+)\|([^>]+)>/g, '$2 ($1)')
            .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1'))
        .join('\n')
        .trim();
}

function extractBlockText(block) {
    if (!block) return '';
    if (typeof block.text === 'string') return block.text;
    if (block.text && typeof block.text.text === 'string') return block.text.text;
    if (Array.isArray(block.elements)) {
        return block.elements
            .map((el) => {
                if (!el) return '';
                if (typeof el.text === 'string') return el.text;
                if (typeof el.url === 'string') return el.url;
                if (Array.isArray(el.elements)) return extractBlockText(el);
                return '';
            })
            .filter(Boolean)
            .join(' ');
    }
    return '';
}

module.exports = {
    cleanHtml,
    slackMessageToText,
    truncate,
    DEFAULT_MAX_CHARS,
};
