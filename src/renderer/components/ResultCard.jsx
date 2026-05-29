import React, { useState } from 'react';
import SourceBadge from './SourceBadge';

function escapeRegex(term) {
    return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(text, query) {
    if (!query || !text) {
        return text;
    }

    const terms = query.trim().split(/\s+/).filter(Boolean).map(escapeRegex);
    if (!terms.length) {
        return text;
    }

    const regex = new RegExp(`(${terms.join('|')})`, 'gi');
    const parts = text.split(regex);

    return parts.map((part, index) => {
        const isMatch = terms.some((term) => new RegExp(`^${term}$`, 'i').test(part));
        return isMatch
            ? <mark key={`${part}-${index}`} className="bg-yellow-200/80 dark:bg-yellow-500/30 text-yellow-900 dark:text-yellow-200 rounded px-0.5">{part}</mark>
            : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>;
    });
}

// One row in the expanded panel: "Label  value  📋"
function DetailRow({ label, value, copyKey, onCopy, copiedKey, mono = false, multiline = false }) {
    if (!value) return null;
    return (
        <div className="flex items-start gap-3 group/row">
            <span className="text-slate-500 dark:text-slate-400 font-medium shrink-0 w-20 pt-0.5 text-[11px] uppercase tracking-wider">{label}</span>
            <div className={`flex-1 text-slate-800 dark:text-slate-200 break-words ${mono ? 'font-mono text-[11px]' : ''} ${multiline ? 'whitespace-pre-wrap leading-relaxed' : ''}`}>
                {value}
            </div>
            {copyKey && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onCopy(copyKey, typeof value === 'string' ? value : String(value)); }}
                    className="shrink-0 text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-white dark:hover:bg-slate-800 px-2 py-1 rounded transition-colors opacity-0 group-hover/row:opacity-100"
                    title={`Copy ${label.toLowerCase()}`}
                >
                    {copiedKey === copyKey ? '✓' : '📋'}
                </button>
            )}
        </div>
    );
}

export default function ResultCard({ result, query }) {
    const [expanded, setExpanded] = useState(false);
    const [showRaw, setShowRaw] = useState(false);
    const [copiedKey, setCopiedKey] = useState(null);

    const openLink = (e) => {
        if (e) e.stopPropagation();
        if (!result.link) return;
        const useSidePanel = result.source === 'Slack' && e && e.shiftKey;
        if (useSidePanel) {
            window.perfectsearch.openSlackInPanel(result.link);
        } else {
            window.perfectsearch.openLink(result.link);
        }
    };

    const toggleExpand = (e) => {
        e.stopPropagation();
        setExpanded((v) => !v);
    };

    const handleCopy = async (key, text) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedKey(key);
            setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
        } catch (_) {
            // ignore — copy can fail in some sandboxed contexts
        }
    };

    const copyAllText = [
        result.title,
        result.link,
        result.author ? `Author: ${result.author}` : null,
        result.channel ? `Channel: #${result.channel}` : null,
        result.space ? `Space: ${result.space}` : null,
        result.meta ? result.meta : null,
        result.date ? `Date: ${new Date(result.date).toLocaleString()}` : null,
        ...(result.extras
            ? Object.entries(result.extras)
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .map(([k, v]) => `${k}: ${v}`)
            : []),
        '',
        result.snippet,
    ].filter(Boolean).join('\n');

    return (
        <div className="result-card bg-white dark:bg-slate-900/70 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-card-enter">
            {/* Header / collapsed view ----------------------------------------- */}
            <div className="p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                    <h3
                        className="text-sm font-semibold leading-snug flex-1 cursor-pointer select-text
                            text-slate-900 dark:text-slate-100
                            hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                        onClick={openLink}
                        title="Open in browser (Shift+Click on Slack to open in side panel)"
                    >
                        {highlight(result.title, query)}
                    </h3>
                    <div className="flex items-center gap-2 shrink-0">
                        <SourceBadge source={result.source} type={result.type} />
                        <button
                            type="button"
                            onClick={toggleExpand}
                            className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md px-1.5 py-0.5 leading-none transition-colors"
                            aria-label={expanded ? 'Collapse details' : 'Expand details'}
                            title={expanded ? 'Collapse' : 'Expand for full details'}
                        >
                            <span className={`inline-block text-base transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▾</span>
                        </button>
                    </div>
                </div>

                {result.snippet && (
                    <p className={`text-xs leading-relaxed mb-2 select-text text-slate-600 dark:text-slate-400 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                        {highlight(result.snippet, query)}
                    </p>
                )}

                <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-500 flex-wrap select-text">
                    {result.author && <span className="inline-flex items-center gap-1"><span aria-hidden>👤</span>{result.author}</span>}
                    {result.channel && <span className="inline-flex items-center gap-1"><span aria-hidden>💬</span>#{result.channel}</span>}
                    {result.space && <span className="inline-flex items-center gap-1"><span aria-hidden>📁</span>{result.space}</span>}
                    {result.meta && <span className="inline-flex items-center gap-1"><span aria-hidden>ℹ️</span>{result.meta}</span>}
                    {result.date && <span className="inline-flex items-center gap-1"><span aria-hidden>🕒</span>{new Date(result.date).toLocaleDateString()}</span>}
                    {!expanded && result.link && (
                        <span className="ml-auto text-indigo-500 dark:text-indigo-400 truncate max-w-xs font-mono text-[10px]">
                            {result.link.replace(/^https?:\/\//, '')}
                        </span>
                    )}
                </div>
            </div>

            {/* Expanded details panel ------------------------------------------ */}
            {expanded && (
                <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-4 py-3 select-text animate-fade-in">
                    <div className="flex flex-col gap-2 text-xs">
                        <DetailRow
                            label="Title"
                            value={result.title}
                            copyKey="title"
                            onCopy={handleCopy}
                            copiedKey={copiedKey}
                        />
                        <DetailRow
                            label="URL"
                            value={result.link ? (
                                <a
                                    href={result.link}
                                    onClick={openLink}
                                    className="text-blue-700 hover:underline break-all"
                                >
                                    {result.link}
                                </a>
                            ) : null}
                            copyKey={result.link ? 'link' : null}
                            onCopy={(key) => handleCopy(key, result.link)}
                            copiedKey={copiedKey}
                            mono
                        />
                        <DetailRow
                            label="Source"
                            value={`${result.source}${result.type ? ' · ' + result.type : ''}`}
                        />
                        <DetailRow label="Author" value={result.author} />
                        <DetailRow label="Channel" value={result.channel ? `#${result.channel}` : null} />
                        <DetailRow label="Space" value={result.space} />
                        <DetailRow label="Info" value={result.meta} />
                        <DetailRow label="Date" value={result.date ? new Date(result.date).toLocaleString() : null} />
                        <DetailRow
                            label="Content"
                            value={result.snippet}
                            copyKey={result.snippet ? 'snippet' : null}
                            onCopy={handleCopy}
                            copiedKey={copiedKey}
                            multiline
                        />

                        {/* Per-source extra fields — connector decides what to include */}
                        {result.extras && Object.entries(result.extras).filter(([, v]) => v !== null && v !== undefined && v !== '').length > 0 && (
                            <>
                                <div className="pt-2 mt-1 border-t border-slate-200 dark:border-slate-700">
                                    <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1.5">More details</p>
                                </div>
                                {Object.entries(result.extras)
                                    .filter(([, v]) => v !== null && v !== undefined && v !== '')
                                    .map(([label, value]) => (
                                        <DetailRow
                                            key={label}
                                            label={label}
                                            value={String(value)}
                                            copyKey={`extra-${label}`}
                                            onCopy={handleCopy}
                                            copiedKey={copiedKey}
                                            mono={/id$|ts$|link/i.test(label)}
                                        />
                                    ))}
                            </>
                        )}

                        {/* Raw JSON view for power users — toggle */}
                        <div className="pt-2 mt-1 border-t border-slate-200 dark:border-slate-700">
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setShowRaw((v) => !v); }}
                                className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                            >
                                {showRaw ? '▴ Hide raw data' : '▾ Show raw data (JSON)'}
                            </button>
                            {showRaw && (
                                <pre className="mt-2 text-[10px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 overflow-x-auto select-text whitespace-pre-wrap break-all font-mono text-slate-700 dark:text-slate-300 max-h-64 overflow-y-auto">
                                    {JSON.stringify(result, null, 2)}
                                </pre>
                            )}
                        </div>

                        <div className="flex gap-2 pt-3 mt-1 border-t border-slate-200 dark:border-slate-700">
                            <button
                                type="button"
                                onClick={openLink}
                                className="text-xs bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white px-3.5 py-1.5 rounded-md font-medium shadow-sm shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40"
                            >
                                ↗ Open in browser
                            </button>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleCopy('all', copyAllText); }}
                                className="text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3.5 py-1.5 rounded-md font-medium transition-colors"
                            >
                                {copiedKey === 'all' ? '✓ Copied all' : '📋 Copy all'}
                            </button>
                            <button
                                type="button"
                                onClick={toggleExpand}
                                className="ml-auto text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 px-3 py-1.5 rounded-md transition-colors"
                            >
                                Collapse ▴
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
