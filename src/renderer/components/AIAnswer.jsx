import React, { useEffect, useRef, useState } from 'react';

// Minimal Markdown → HTML for the AI answer. Hand-rolled to keep the
// dependency surface small and predictable. Handles:
//   - Headings: ## Title
//   - Bullets: - item / * item
//   - Bold: **text**
//   - Italic: *text*
//   - Inline code: `code`
//   - Citations: [1], [2,3] → clickable chips that scroll to the source
//   - Paragraphs separated by blank lines
function renderMarkdown(text, onCitationClick) {
    if (!text) return null;

    const inline = (line) => {
        // Pass through with citation chip parsing — return an array of nodes
        const parts = [];
        let i = 0;
        let buf = '';
        const flush = () => {
            if (buf) {
                parts.push(formatInline(buf, parts.length));
                buf = '';
            }
        };
        const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
        let last = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
            buf += line.slice(last, m.index);
            flush();
            const nums = m[1].split(/\s*,\s*/).map((n) => parseInt(n, 10));
            for (const n of nums) {
                parts.push(
                    <button
                        key={`c-${i}-${n}-${parts.length}`}
                        type="button"
                        onClick={() => onCitationClick && onCitationClick(n)}
                        className="inline-flex items-center justify-center min-w-[18px] h-[18px] mx-0.5 px-1 text-[10px] font-bold rounded-md align-middle
                            bg-indigo-100 text-indigo-700 hover:bg-indigo-200
                            dark:bg-indigo-500/20 dark:text-indigo-300 dark:hover:bg-indigo-500/30 transition-colors"
                        title={`Jump to source ${n}`}
                    >
                        {n}
                    </button>
                );
                i++;
            }
            last = re.lastIndex;
        }
        buf += line.slice(last);
        flush();
        return parts;
    };

    const formatInline = (s, key) => {
        // Bold then italic then inline-code — done with regex split for simplicity
        const nodes = [];
        // We process in passes; small, predictable for short answer text.
        const tokens = [];
        let rest = s;
        const patterns = [
            { re: /^`([^`]+)`/, type: 'code' },
            { re: /^\*\*([^*]+)\*\*/, type: 'bold' },
            { re: /^\*([^*]+)\*/, type: 'italic' },
        ];
        let safety = 0;
        while (rest.length > 0 && safety++ < 5000) {
            let matched = false;
            for (const p of patterns) {
                const m = rest.match(p.re);
                if (m) {
                    tokens.push({ type: p.type, value: m[1] });
                    rest = rest.slice(m[0].length);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                // consume one char of plain text, batching for fewer nodes
                const next = rest.search(/[`*]/);
                const take = next === -1 ? rest.length : next || 1;
                tokens.push({ type: 'text', value: rest.slice(0, take) });
                rest = rest.slice(take);
            }
        }
        return tokens.map((t, idx) => {
            const k = `${key}-${idx}`;
            if (t.type === 'bold') return <strong key={k} className="font-semibold text-slate-900 dark:text-slate-100">{t.value}</strong>;
            if (t.type === 'italic') return <em key={k}>{t.value}</em>;
            if (t.type === 'code') return <code key={k} className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[12px] font-mono text-rose-700 dark:text-rose-300">{t.value}</code>;
            return <React.Fragment key={k}>{t.value}</React.Fragment>;
        });
    };

    const lines = text.split('\n');
    const out = [];
    let listBuf = null;

    const flushList = () => {
        if (listBuf) {
            out.push(
                <ul key={`ul-${out.length}`} className="list-disc list-outside ml-5 my-2 space-y-1 marker:text-indigo-500 dark:marker:text-indigo-400">
                    {listBuf}
                </ul>
            );
            listBuf = null;
        }
    };

    for (let li = 0; li < lines.length; li++) {
        const raw = lines[li];
        const line = raw.replace(/\s+$/, '');
        if (/^\s*##\s+/.test(line)) {
            flushList();
            out.push(
                <h3 key={`h-${li}`} className="text-base font-bold text-slate-900 dark:text-slate-100 mt-4 mb-1.5">
                    {inline(line.replace(/^\s*##\s+/, ''))}
                </h3>
            );
        } else if (/^\s*###\s+/.test(line)) {
            flushList();
            out.push(
                <h4 key={`h-${li}`} className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-3 mb-1">
                    {inline(line.replace(/^\s*###\s+/, ''))}
                </h4>
            );
        } else if (/^\s*[-*]\s+/.test(line)) {
            if (!listBuf) listBuf = [];
            listBuf.push(
                <li key={`li-${li}`} className="text-slate-700 dark:text-slate-300 leading-relaxed">
                    {inline(line.replace(/^\s*[-*]\s+/, ''))}
                </li>
            );
        } else if (line.trim() === '') {
            flushList();
            // paragraph break — no node needed; spacing comes from margins
        } else {
            flushList();
            out.push(
                <p key={`p-${li}`} className="text-slate-700 dark:text-slate-300 leading-relaxed my-1.5">
                    {inline(line)}
                </p>
            );
        }
    }
    flushList();
    return out;
}

export default function AIAnswer({ query, results, mode = 'internal', onCitationClick, onOpenSettings }) {
    const [text, setText] = useState('');
    const [status, setStatus] = useState('idle');
    const [error, setError] = useState(null);
    const [usage, setUsage] = useState(null);
    const [picked, setPicked] = useState([]);
    const [webSources, setWebSources] = useState([]);
    const [provider, setProvider] = useState(null);
    const [model, setModel] = useState(null);
    const [providers, setProviders] = useState([]);
    const requestIdRef = useRef(0);

    const isWeb = mode === 'web';

    const run = async () => {
        const requestId = ++requestIdRef.current;
        setText('');
        setError(null);
        setUsage(null);
        setPicked([]);
        setWebSources([]);
        setStatus('streaming');

        try {
            const statusResp = await window.perfectsearch.getAiProviders();
            setProviders(statusResp.providers || []);
            if (!statusResp.active) {
                setStatus('unconfigured');
                return;
            }

            const resp = isWeb
                ? await window.perfectsearch.aiSynthesizeWeb(
                    requestId, query,
                    (delta) => { if (requestId === requestIdRef.current) setText((p) => p + delta); }
                )
                : await window.perfectsearch.aiSynthesize(
                    requestId, query, results,
                    (delta) => { if (requestId === requestIdRef.current) setText((p) => p + delta); }
                );

            if (requestId !== requestIdRef.current) return;

            if (resp.success) {
                setUsage(resp.data.usage);
                setPicked(resp.data.picked || []);
                setWebSources(resp.data.webSources || []);
                setProvider(resp.data.provider || null);
                setModel(resp.data.model || null);
                setStatus('done');
            } else {
                setError(resp.error);
                setStatus('error');
            }
        } catch (e) {
            if (requestId !== requestIdRef.current) return;
            setError(e.message);
            setStatus('error');
        }
    };

    useEffect(() => {
        if (status === 'idle') run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const copyAnswer = async () => {
        try { await navigator.clipboard.writeText(text); } catch (_) {}
    };

    const containerGradient = isWeb
        ? 'from-sky-50/80 via-white to-cyan-50/60 dark:from-sky-950/40 dark:via-slate-900/60 dark:to-cyan-950/30 border-sky-200/70 dark:border-sky-800/50'
        : 'from-indigo-50/80 via-white to-purple-50/60 dark:from-indigo-950/40 dark:via-slate-900/60 dark:to-purple-950/30 border-indigo-200/70 dark:border-indigo-800/50';
    const titleGradient = isWeb
        ? 'from-sky-600 via-cyan-600 to-teal-600 dark:from-sky-400 dark:via-cyan-400 dark:to-teal-400'
        : 'from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400';
    const icon = isWeb ? '🌐' : '✨';
    const title = isWeb ? 'Web Research' : 'PerfectSearch AI';

    return (
        <div className={`relative rounded-2xl border bg-gradient-to-br p-5 shadow-sm animate-slide-up ${containerGradient}`}>
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <span className="text-lg">{icon}</span>
                    <span className={`font-bold text-sm bg-gradient-to-r bg-clip-text text-transparent ${titleGradient}`}>
                        {title}
                    </span>
                    {status === 'streaming' && (
                        <span className="text-[10px] uppercase tracking-wider text-indigo-600 dark:text-indigo-400 font-semibold flex items-center gap-1">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                            Synthesizing…
                        </span>
                    )}
                    {status === 'done' && (
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                            {provider && <span className="text-slate-500 dark:text-slate-400 mr-1">{provider}{model ? `/${model}` : ''}</span>}
                            {usage && <>
                                {usage.input_tokens}↑ {usage.output_tokens}↓
                                {usage.cache_read_input_tokens ? ` · cached ${usage.cache_read_input_tokens}` : ''}
                            </>}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1.5">
                    {text && (
                        <button
                            type="button"
                            onClick={copyAnswer}
                            className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 px-2 py-1 rounded-md hover:bg-white/60 dark:hover:bg-slate-800/60 transition-colors"
                            title="Copy answer"
                        >
                            📋 Copy
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={run}
                        disabled={status === 'streaming'}
                        className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 px-2 py-1 rounded-md hover:bg-white/60 dark:hover:bg-slate-800/60 transition-colors disabled:opacity-40"
                        title="Re-run synthesis"
                    >
                        ↻ Re-ask
                    </button>
                </div>
            </div>

            {status === 'unconfigured' && (() => {
                const configured = providers.filter((p) => p.configured);
                const hasAnyKey = configured.length > 0;
                const providerOptions = [
                    { name: 'Anthropic Claude', host: 'console.anthropic.com', supportsWeb: true },
                    { name: 'Google Gemini', host: 'aistudio.google.com', supportsWeb: true },
                    { name: 'OpenAI', host: 'platform.openai.com', supportsWeb: false },
                ];
                const relevant = isWeb ? providerOptions.filter((p) => p.supportsWeb) : providerOptions;
                return (
                    <div className="text-sm text-slate-700 dark:text-slate-300 p-3 rounded-lg bg-white/60 dark:bg-slate-800/40 border border-dashed border-slate-300 dark:border-slate-700">
                        {hasAnyKey ? (
                            <>
                                <p className="mb-2">
                                    <strong>No active AI provider.</strong> You have a key saved for{' '}
                                    <span className="font-semibold">{configured.map((p) => p.name).join(', ')}</span>
                                    {' '}— open Settings and click <em>Use</em> on one to activate it.
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="mb-2">
                                    <strong>Set an API key in Settings</strong> to enable {isWeb ? 'web research' : 'AI synthesis'}.
                                    Any one of these providers works:
                                </p>
                                <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-0.5 mb-2 ml-1">
                                    {relevant.map((p) => (
                                        <li key={p.name}>
                                            • <span className="font-semibold">{p.name}</span> — key at{' '}
                                            <span className="font-mono">{p.host}</span>
                                            {isWeb ? '' : ''}
                                        </li>
                                    ))}
                                </ul>
                                {isWeb && (
                                    <p className="text-[11px] text-slate-500 dark:text-slate-400 italic">
                                        Note: Web Research needs Anthropic or Gemini — OpenAI doesn't expose a web-search tool.
                                    </p>
                                )}
                            </>
                        )}
                        {onOpenSettings && (
                            <button
                                type="button"
                                onClick={onOpenSettings}
                                className="mt-2 inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md
                                    bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
                            >
                                ⚙ Open Settings
                            </button>
                        )}
                    </div>
                );
            })()}

            {status === 'error' && (() => {
                // Two known "errors" are really just informational states the
                // user can act on — render them as soft notices, not red
                // failures.
                const msg = String(error || '');
                const isNoSources = msg === 'NO_SOURCES' || /^NO_SOURCES/.test(msg);
                const isWebUnsupported = /^WEB_NOT_SUPPORTED/.test(msg);

                if (isNoSources) {
                    return (
                        <div className="text-sm text-slate-700 dark:text-slate-300 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-dashed border-slate-300 dark:border-slate-700">
                            <p className="mb-1">
                                <strong>No internal results to synthesize.</strong>
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Try a broader search term, connect more sources in Settings, or use <strong>Web Research</strong> below if you want a public-web answer.
                            </p>
                        </div>
                    );
                }
                if (isWebUnsupported) {
                    // Strip the "WEB_NOT_SUPPORTED: " prefix from the message.
                    const detail = msg.replace(/^WEB_NOT_SUPPORTED:\s*/, '');
                    return (
                        <div className="text-sm text-slate-700 dark:text-slate-300 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50">
                            <p className="mb-2">
                                <strong>Web Research not available with your current AI provider.</strong>
                            </p>
                            <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                                {detail || 'OpenAI does not expose a web-search tool. Switch to Anthropic Claude or Google Gemini in Settings to use Web Research.'}
                            </p>
                            {onOpenSettings && (
                                <button
                                    type="button"
                                    onClick={onOpenSettings}
                                    className="text-xs px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors"
                                >
                                    ⚙ Open Settings
                                </button>
                            )}
                        </div>
                    );
                }
                return (
                    <div className="text-sm text-red-700 dark:text-red-300 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900">
                        <strong>AI synthesis failed:</strong> {error}
                    </div>
                );
            })()}

            {(status === 'streaming' || status === 'done') && (
                <div className="prose-sm max-w-none">
                    {text ? renderMarkdown(text, onCitationClick) : (
                        <p className="text-sm text-slate-400 dark:text-slate-500 italic">Reading sources…</p>
                    )}
                    {status === 'streaming' && (
                        <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-indigo-500 dark:bg-indigo-400 animate-pulse align-middle" />
                    )}
                </div>
            )}

            {status === 'done' && !isWeb && picked.length > 0 && (
                <div className="mt-4 pt-3 border-t border-indigo-200/60 dark:border-indigo-800/40">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
                        Sources used ({picked.length})
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {picked.map((p, i) => (
                            <button
                                key={p.id || i}
                                type="button"
                                onClick={() => onCitationClick && onCitationClick(i + 1)}
                                className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full
                                    bg-white/70 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300
                                    border border-slate-200 dark:border-slate-700
                                    hover:border-indigo-400 dark:hover:border-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
                                title={p.title}
                            >
                                <span className="font-bold opacity-70">{i + 1}</span>
                                <span className="truncate max-w-[180px]">{p.title}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {status === 'done' && isWeb && webSources.length > 0 && (
                <div className="mt-4 pt-3 border-t border-sky-200/60 dark:border-sky-800/40">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
                        External sources ({webSources.length})
                    </p>
                    <div className="flex flex-col gap-1.5">
                        {webSources.map((s, i) => (
                            <a
                                key={`${s.url}-${i}`}
                                href={s.url}
                                onClick={(e) => { e.preventDefault(); window.perfectsearch.openLink(s.url); }}
                                className="group flex items-start gap-2 text-xs p-2 rounded-md
                                    bg-white/70 dark:bg-slate-800/60
                                    border border-slate-200 dark:border-slate-700
                                    hover:border-sky-400 dark:hover:border-sky-500 transition-colors"
                                title={s.url}
                            >
                                <span className="text-[10px] font-bold text-sky-600 dark:text-sky-400 mt-0.5">[{i + 1}]</span>
                                <div className="flex-1 min-w-0">
                                    <div className="text-slate-800 dark:text-slate-200 font-medium truncate group-hover:text-sky-700 dark:group-hover:text-sky-300">{s.title || s.url}</div>
                                    <div className="text-[10px] text-slate-500 dark:text-slate-500 font-mono truncate">{s.url.replace(/^https?:\/\//, '')}</div>
                                </div>
                                <span className="text-slate-400 dark:text-slate-500 text-xs">↗</span>
                            </a>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
