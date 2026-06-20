const { extractZipText, extractXlsxText, smartSliceLog, looksTextualStr } = require('../../connectors/servicenow');
const logger = require('../../utils/logger');

// Turn an uploaded file (base64 bytes from the renderer) into something the
// expert can use: a vision image, or extracted text. Reuses the same readers
// the ServiceNow case-analysis feature uses (zip / xlsx / log / .lis / text).
// Returns { kind: 'image', image: {name, mime, base64} } or
//         { kind: 'text', text } .
async function processUpload({ name, mime, base64 }) {
    const lower = (name || '').toLowerCase();
    const isImage = /^image\//i.test(mime || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(lower);
    if (isImage) {
        return { kind: 'image', image: { name, mime: mime || 'image/png', base64 } };
    }

    let buf;
    try { buf = Buffer.from(base64 || '', 'base64'); } catch (_) { buf = Buffer.alloc(0); }

    try {
        if (/zip/i.test(mime || '') || /\.zip$/i.test(lower)) {
            const { text, entries, inspected, error } = await extractZipText(buf);
            logger.info('Phase 8', `Upload zip ${name}: ${buf.length}B entries=[${(inspected || []).join(', ')}]${error ? ' err=' + error : ''}`);
            return { kind: 'text', text: text && text.trim() ? `UPLOADED FILE ${name} (unzipped: ${entries.join(', ')})\n${text}` : `UPLOADED FILE ${name}: (zip had no readable text)` };
        }
        if (/spreadsheetml|ms-excel/i.test(mime || '') || /\.xlsx?$/i.test(lower)) {
            const { text, sheets } = await extractXlsxText(buf);
            logger.info('Phase 8', `Upload xlsx ${name}: ${buf.length}B sheets=[${(sheets || []).join(', ')}]`);
            return { kind: 'text', text: text && text.trim() ? `UPLOADED FILE ${name} (xlsx)\n${text}` : `UPLOADED FILE ${name}: (no cell text)` };
        }
        // Anything else: sniff as text (logs, .lis, .json, .csv, AWS/Datadog dumps).
        const s = buf.toString('utf8');
        if (looksTextualStr(s)) {
            return { kind: 'text', text: `UPLOADED FILE ${name}\n${smartSliceLog(s, 14000)}` };
        }
        return { kind: 'text', text: `UPLOADED FILE ${name}: (binary, not read — ${mime || 'unknown type'})` };
    } catch (e) {
        return { kind: 'text', text: `UPLOADED FILE ${name}: (could not read — ${e && e.message})` };
    }
}

module.exports = { processUpload };
