const axios = require('axios');
const tokenStore = require('../../../auth/tokenStore');
const logger = require('../../../utils/logger');
const { cleanHtml } = require('../extractor');

// Fetch the full body + comments of a ServiceNow record using the user's
// existing SSO cookie session. The connector saves the sys_id in
// extras['Sys ID'] and the result.id prefix tells us the table:
//   snow-case-XXXX  → sn_customerservice_case
//   snow-inc-XXXX   → incident
//   snow-kb-XXXX    → kb_knowledge

const TABLE_BY_ID_PREFIX = {
    'snow-case-': 'sn_customerservice_case',
    'snow-inc-':  'incident',
    'snow-kb-':   'kb_knowledge',
};

// Different ServiceNow tables expose useful content in different fields.
// We pull more than we strictly need so the cleaner can prioritise what
// to include; truncation happens after concatenation.
const FIELDS_BY_TABLE = {
    incident:                'number,short_description,description,close_notes,comments,work_notes,resolution_code,state,priority,opened_by,assigned_to,sys_created_on,sys_updated_on',
    sn_customerservice_case: 'number,short_description,description,close_notes,comments,work_notes,resolution_code,state,priority,opened_by,assigned_to,sys_created_on,sys_updated_on',
    kb_knowledge:            'number,short_description,text,kb_category,workflow_state,author,sys_view_count,sys_updated_on',
};

function detectTable(result) {
    if (!result) return null;
    // Primary: parse the result.id prefix the connector sets.
    if (typeof result.id === 'string') {
        for (const prefix of Object.keys(TABLE_BY_ID_PREFIX)) {
            if (result.id.startsWith(prefix)) return TABLE_BY_ID_PREFIX[prefix];
        }
    }
    // Fallback: parse the URL. Runs even when result.id is absent so the
    // dispatcher can still recognise a record from a permalink alone.
    const link = result.link || '';
    if (/sn_customerservice_case/.test(link)) return 'sn_customerservice_case';
    if (/incident\.do/.test(link)) return 'incident';
    if (/kb_view\.do|sys_kb_id=/.test(link)) return 'kb_knowledge';
    return null;
}

function getSysId(result) {
    if (result?.extras && typeof result.extras['Sys ID'] === 'string') return result.extras['Sys ID'];
    const link = result?.link || '';
    const m = link.match(/sys_(?:id|kb_id)=([a-f0-9]{32})/i);
    return m ? m[1] : null;
}

/**
 * ServiceNow comments and work_notes come back as journal-style multi-line
 * strings: "2025-09-12 14:22:01 - John Doe (Comments)\nfull text...".
 * We keep the metadata header but flatten whitespace so it reads naturally.
 */
function formatJournal(field, raw) {
    if (!raw) return '';
    const text = String(raw).trim();
    if (!text) return '';
    return `\n\n## ${field}\n${text}`;
}

async function fetchServiceNow(result, { maxChars = 4096, timeoutMs = 5000 } = {}) {
    const tokens = tokenStore.get('servicenow');
    if (!tokens || !tokens.cookieHeader) return null;

    const table = detectTable(result);
    const sysId = getSysId(result);
    if (!table || !sysId) {
        logger.info('Phase 6', `[fetch:servicenow] missing table/sys_id for ${result?.id} — skipping`);
        return null;
    }

    const baseUrl = tokens.baseUrl || process.env.SERVICENOW_BASE_URL;
    if (!baseUrl) return null;

    const fields = FIELDS_BY_TABLE[table] || FIELDS_BY_TABLE.incident;
    const url = `${baseUrl}/api/now/table/${table}/${sysId}`;
    try {
        const resp = await axios.get(url, {
            params: { sysparm_display_value: 'true', sysparm_fields: fields },
            headers: {
                Cookie: tokens.cookieHeader,
                Accept: 'application/json',
                'X-UserToken': tokens.csrfToken || tokens.ck || '',
            },
            timeout: timeoutMs,
        });
        const r = resp.data?.result || {};
        const parts = [];

        if (r.short_description) parts.push(`# ${r.short_description}`);
        if (r.state || r.priority) {
            const meta = [r.state && `state: ${r.state}`, r.priority && `priority: ${r.priority}`].filter(Boolean).join(' · ');
            if (meta) parts.push(`*${meta}*`);
        }
        if (r.description) parts.push(`\n## Description\n${cleanHtml(String(r.description), { maxChars: 1500 })}`);
        if (r.text)        parts.push(`\n## Article\n${cleanHtml(String(r.text), { maxChars: 1800 })}`);
        if (r.work_notes)  parts.push(formatJournal('Work notes', r.work_notes));
        if (r.comments)    parts.push(formatJournal('Comments', r.comments));
        if (r.close_notes) parts.push(formatJournal('Close notes', r.close_notes));
        if (r.resolution_code) parts.push(`\nResolution code: ${r.resolution_code}`);

        const combined = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (!combined) return null;

        const truncated = combined.length > maxChars
            ? combined.slice(0, maxChars) + '\n\n[truncated — more content available]'
            : combined;

        logger.info('Phase 6', `[fetch:servicenow] ${table}/${sysId.slice(0, 8)}… → ${truncated.length} chars`);
        return {
            fullContent: truncated,
            metadata: {
                number: r.number || null,
                table,
                state: r.state || null,
                assignedTo: r.assigned_to || null,
                updated: r.sys_updated_on || null,
            },
        };
    } catch (err) {
        logger.warn('Phase 6', `[fetch:servicenow] ${table}/${sysId.slice(0, 8)}… failed: ${err.message}`);
        return null;
    }
}

module.exports = { fetchServiceNow, detectTable, getSysId };
