import React, { useCallback, useEffect, useRef, useState } from 'react';
import { renderMarkdown } from './AIAnswer';

// "Ask AI Expert" — conversational analyst (Phase A: chat MVP).
// Left: thread list. Right: chat thread with streaming replies.
export default function ExpertPanel() {
    const [threads, setThreads] = useState([]);
    const [activeId, setActiveId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [streamText, setStreamText] = useState('');
    const [toolEvents, setToolEvents] = useState([]);
    const [attachments, setAttachments] = useState([]); // {name, mime, base64}
    const reqRef = useRef(0);
    const scrollRef = useRef(null);
    const inputRef = useRef(null);
    const fileInputRef = useRef(null);

    const readFileAsBase64 = (file) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const res = String(reader.result || '');
            const base64 = res.includes(',') ? res.split(',')[1] : res;
            resolve({ name: file.name, mime: file.type || '', base64 });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });

    const onPickFiles = useCallback(async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        const read = (await Promise.all(files.map(readFileAsBase64))).filter(Boolean);
        setAttachments((p) => [...p, ...read]);
    }, []);

    const removeAttachment = useCallback((idx) => {
        setAttachments((p) => p.filter((_, i) => i !== idx));
    }, []);

    const [modelLabel, setModelLabel] = useState('');

    const loadThreads = useCallback(async () => {
        const r = await window.perfectsearch.expertListThreads();
        if (r.success) setThreads(r.threads || []);
        return r.success ? (r.threads || []) : [];
    }, []);

    // On mount: load threads (auto-open the most recent) and the active model.
    useEffect(() => {
        (async () => {
            const list = await loadThreads();
            if (list.length && !activeId) {
                const r = await window.perfectsearch.expertGetThread(list[0].id);
                if (r.success && r.thread) { setActiveId(list[0].id); setMessages(r.thread.messages || []); }
            }
            try {
                const p = await window.perfectsearch.getAiProviders();
                const active = (p.providers || []).find((x) => x.id === p.active);
                if (active) setModelLabel(`${active.name} · ${active.activeModel}`);
            } catch (_) { /* ignore */ }
        })();
    }, []);

    // Knowledge index (Phase 0)
    const [indexStats, setIndexStats] = useState(null);
    const [indexBuilding, setIndexBuilding] = useState(false);
    const [indexProgress, setIndexProgress] = useState('');
    const idxReqRef = useRef(0);

    const loadIndexStats = useCallback(async () => {
        const r = await window.perfectsearch.expertIndexStats();
        if (r.success) setIndexStats(r.stats);
    }, []);

    useEffect(() => { loadIndexStats(); }, [loadIndexStats]);

    const buildIndex = useCallback(async () => {
        if (indexBuilding) return;
        setIndexBuilding(true);
        setIndexProgress('starting…');
        const requestId = ++idxReqRef.current;
        try {
            await window.perfectsearch.expertBuildIndex(requestId, (p) => {
                if (p.phase === 'search') setIndexProgress(`searching ${p.i}/${p.total} · ${p.collected} docs`);
                else if (p.phase === 'confluence') setIndexProgress(`Confluence: ${p.count} pages…`);
                else if (p.phase === 'servicenow-kb') setIndexProgress(`ServiceNow KB: ${p.count}…`);
                else if (p.phase === 'web') setIndexProgress(`Docs site: ${p.count} pages…`);
                else if (p.phase === 'embed') setIndexProgress(`embedding ${p.total} docs…`);
                else if (p.phase === 'done') setIndexProgress(p.quotaExhausted ? `${p.count} docs · OpenAI quota exhausted — add credits, then Build again to embed` : `+${p.added} new (${p.count} total · ${p.withEmbeddings} embedded)`);
            });
            await loadIndexStats();
        } catch (e) {
            setIndexProgress(`error: ${e.message}`);
        } finally {
            setIndexBuilding(false);
            setTimeout(() => setIndexProgress(''), 4000);
        }
    }, [indexBuilding, loadIndexStats]);

    const openThread = useCallback(async (id) => {
        const r = await window.perfectsearch.expertGetThread(id);
        if (r.success && r.thread) {
            setActiveId(id);
            setMessages(r.thread.messages || []);
            setStreamText('');
        }
    }, []);

    const newChat = useCallback(async () => {
        const r = await window.perfectsearch.expertNewThread({});
        if (r.success && r.thread) {
            setActiveId(r.thread.id);
            setMessages([]);
            setStreamText('');
            loadThreads();
            if (inputRef.current) inputRef.current.focus();
        }
    }, [loadThreads]);

    const deleteThread = useCallback(async (id, e) => {
        e.stopPropagation();
        await window.perfectsearch.expertDeleteThread(id);
        if (activeId === id) { setActiveId(null); setMessages([]); }
        loadThreads();
    }, [activeId, loadThreads]);

    const send = useCallback(async () => {
        const text = input.trim();
        const atts = attachments;
        if ((!text && atts.length === 0) || busy) return;
        let id = activeId;
        if (!id) {
            const r = await window.perfectsearch.expertNewThread({});
            if (!r.success) return;
            id = r.thread.id;
            setActiveId(id);
        }
        setInput('');
        setAttachments([]);
        const attNote = atts.length ? `\n\n📎 ${atts.map((a) => a.name).join(', ')}` : '';
        setMessages((p) => [...p, { role: 'user', content: (text || '(attachment)') + attNote }]);
        setBusy(true);
        setStreamText('');
        setToolEvents([]);
        const requestId = ++reqRef.current;
        const labelFor = (evt) => {
            if (evt.type !== 'tool') return evt.text || '…';
            if (evt.name === 'search_sources') return `Searching ${(evt.args && evt.args.sources && evt.args.sources.join(', ')) || 'Slack/Confluence/ServiceNow'}: "${(evt.args && evt.args.query) || ''}"`;
            if (evt.name === 'fetch_doc') return `Reading ${(evt.args && evt.args.url) || 'document'}`;
            return evt.name;
        };
        try {
            const resp = await window.perfectsearch.expertSendMessage(
                requestId, id, text, atts,
                (d) => { if (requestId === reqRef.current) setStreamText((p) => p + d); },
                (evt) => { if (requestId === reqRef.current) setToolEvents((p) => [...p, labelFor(evt)]); }
            );
            if (requestId !== reqRef.current) return;
            if (resp.success) {
                setMessages((p) => [...p, { role: 'assistant', content: resp.data.text, model: resp.data.model, provider: resp.data.provider, sources: resp.data.sources || [], usage: resp.data.usage }]);
            } else {
                setMessages((p) => [...p, { role: 'assistant', content: `⚠️ ${resp.error}` }]);
            }
        } catch (e) {
            setMessages((p) => [...p, { role: 'assistant', content: `⚠️ ${e.message}` }]);
        } finally {
            setBusy(false);
            setStreamText('');
            setToolEvents([]);
            loadThreads();
        }
    }, [input, attachments, busy, activeId, loadThreads]);

    const openSource = (s) => { if (s && s.link) { try { window.perfectsearch.openLink(s.link); } catch (_) { /* ignore */ } } };

    const [savingIdx, setSavingIdx] = useState(null);
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const activeThread = threads.find((t) => t.id === activeId);

    const startRename = useCallback(() => {
        if (!activeId) return;
        setTitleDraft((activeThread && activeThread.title) || '');
        setEditingTitle(true);
    }, [activeId, activeThread]);

    const commitRename = useCallback(async () => {
        const title = titleDraft.trim();
        setEditingTitle(false);
        if (!activeId || !title) return;
        await window.perfectsearch.expertRenameThread(activeId, title);
        loadThreads();
    }, [activeId, titleDraft, loadThreads]);

    const exportConversation = useCallback(async () => {
        const md = messages.map((m) => `**${m.role === 'user' ? 'You' : 'AI Expert'}:**\n\n${m.content}`).join('\n\n---\n\n');
        try { await navigator.clipboard.writeText(md); } catch (_) { /* ignore */ }
    }, [messages]);

    const copyMessage = useCallback(async (content) => {
        try { await navigator.clipboard.writeText(content); } catch (_) { /* ignore */ }
    }, []);

    const giveFeedback = useCallback((idx, rating) => {
        const m = messages[idx];
        const links = ((m && m.sources) || []).map((s) => s.link).filter(Boolean);
        setMessages((p) => p.map((mm, i) => (i === idx ? { ...mm, feedback: rating > 0 ? 'up' : 'down' } : mm)));
        try { window.perfectsearch.expertFeedback(rating, links); } catch (_) { /* ignore */ }
    }, [messages]);

    // Inline "save as learning" (Electron has no window.prompt): show a note
    // field under the message, then confirm.
    const [learningIdx, setLearningIdx] = useState(null);
    const [learningNote, setLearningNote] = useState('');

    const beginSaveLearning = useCallback((idx) => {
        setLearningIdx(idx);
        setLearningNote('');
    }, []);

    const confirmSaveLearning = useCallback(async () => {
        const idx = learningIdx;
        const m = messages[idx];
        if (!m) { setLearningIdx(null); return; }
        let problem = '';
        for (let i = idx - 1; i >= 0; i -= 1) { if (messages[i].role === 'user') { problem = messages[i].content; break; } }
        setSavingIdx(idx);
        setLearningIdx(null);
        try {
            const r = await window.perfectsearch.expertSaveLearning({ problem, content: m.content, note: learningNote });
            setMessages((p) => p.map((mm, i) => (i === idx ? { ...mm, saved: !!r.success } : mm)));
            loadIndexStats();
        } finally {
            setSavingIdx(null);
        }
    }, [learningIdx, learningNote, messages, loadIndexStats]);

    const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };

    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages, streamText]);

    return (
        <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
            {/* Thread list */}
            <div className="w-60 shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/60 dark:bg-slate-900/40">
                <div className="p-3 shrink-0 space-y-2">
                    <button
                        type="button"
                        onClick={newChat}
                        className="w-full text-sm font-medium px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors"
                    >
                        + New conversation
                    </button>
                    {/* Knowledge index */}
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Knowledge</span>
                            <button
                                type="button"
                                onClick={buildIndex}
                                disabled={indexBuilding}
                                className="text-[11px] px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 disabled:opacity-50"
                                title="Sweep connected sources into the persistent knowledge index"
                            >
                                {indexBuilding ? 'Building…' : 'Build / refresh'}
                            </button>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">
                            {indexProgress || (indexStats ? `${indexStats.count} docs · ${indexStats.withEmbeddings} embedded` : 'not built yet')}
                        </p>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
                    {threads.length === 0 && (
                        <p className="text-xs text-slate-400 dark:text-slate-500 px-2 py-3">No conversations yet.</p>
                    )}
                    {threads.map((t) => (
                        <div
                            key={t.id}
                            onClick={() => openThread(t.id)}
                            className={`group flex items-center justify-between gap-1 px-2.5 py-2 rounded-lg cursor-pointer text-xs ${activeId === t.id ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-800 dark:text-indigo-200' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'}`}
                        >
                            <span className="truncate">{t.title || 'Untitled'}</span>
                            <button
                                type="button"
                                onClick={(e) => deleteThread(t.id, e)}
                                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 shrink-0"
                                title="Delete conversation"
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            </div>

            {/* Chat area */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                        {editingTitle ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(e) => setTitleDraft(e.target.value)}
                                onBlur={commitRename}
                                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingTitle(false); }}
                                className="w-full text-sm font-semibold bg-transparent border-b border-indigo-400 focus:outline-none text-slate-800 dark:text-slate-100"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={startRename}
                                disabled={!activeId}
                                className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate hover:underline disabled:no-underline disabled:cursor-default text-left max-w-full"
                                title={activeId ? 'Click to rename' : ''}
                            >
                                {activeThread ? activeThread.title : 'Ask AI Expert'}
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {(() => {
                            const cost = messages.reduce((s, m) => s + ((m.usage && m.usage.cost) || 0), 0);
                            const tok = messages.reduce((s, m) => s + ((m.usage && (m.usage.inTok + m.usage.outTok)) || 0), 0);
                            return cost > 0 ? <span className="text-[10px] text-slate-400" title={`${tok} tokens this conversation`}>Σ ${cost.toFixed(cost < 1 ? 4 : 2)}</span> : null;
                        })()}
                        {modelLabel && <span className="text-[10px] text-slate-400 hidden sm:inline">{modelLabel}</span>}
                        {messages.length > 0 && (
                            <button type="button" onClick={exportConversation} className="text-xs px-2 py-1 rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300" title="Copy the whole conversation (markdown) — paste into a ServiceNow work note">
                                Export
                            </button>
                        )}
                    </div>
                </div>
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5">
                    <div className="max-w-3xl mx-auto space-y-4">
                        {messages.length === 0 && !streamText && (
                            <div className="text-center pt-10">
                                <div className="text-4xl mb-2">🧠</div>
                                <h2 className="text-xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent">Ask AI Expert</h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Describe the issue, paste a case, or ask a question. I'll reason it through with you.</p>
                            </div>
                        )}
                        {messages.map((m, i) => (
                            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                                <div className={m.role === 'user'
                                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 text-white px-4 py-2.5 text-sm whitespace-pre-wrap'
                                    : 'max-w-[90%] rounded-2xl rounded-bl-sm bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 px-4 py-3 text-sm'}>
                                    {m.role === 'user' ? m.content : renderMarkdown(m.content, (n) => openSource((m.sources || [])[n - 1]))}
                                    {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
                                        <div className="mt-3 pt-2 border-t border-slate-200 dark:border-slate-700">
                                            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Sources</p>
                                            <ol className="space-y-0.5">
                                                {m.sources.map((s) => (
                                                    <li key={s.n} className="text-xs flex gap-1.5">
                                                        <span className="font-bold text-indigo-600 dark:text-indigo-400 shrink-0">[{s.n}]</span>
                                                        {s.link
                                                            ? <button type="button" onClick={() => openSource(s)} className="text-left hover:underline text-indigo-700 dark:text-indigo-300" title={s.link}>{s.title} <span className="text-slate-400">· {s.source}</span></button>
                                                            : <span>{s.title} <span className="text-slate-400">· {s.source}</span></span>}
                                                    </li>
                                                ))}
                                            </ol>
                                        </div>
                                    )}
                                    {m.role === 'assistant' && !String(m.content).startsWith('⚠️') && (
                                        <div className="mt-2 pt-1.5 flex items-center gap-3 text-xs border-t border-slate-200/60 dark:border-slate-700/60">
                                            <button type="button" onClick={() => giveFeedback(i, 1)} className={m.feedback === 'up' ? 'text-green-600' : 'text-slate-400 hover:text-green-600'} title="Helpful — boost these sources">👍</button>
                                            <button type="button" onClick={() => giveFeedback(i, -1)} className={m.feedback === 'down' ? 'text-red-600' : 'text-slate-400 hover:text-red-600'} title="Not helpful — demote these sources">👎</button>
                                            <button type="button" onClick={() => beginSaveLearning(i)} disabled={savingIdx === i || m.saved} className="text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-60 disabled:no-underline" title="Save this resolution to the knowledge index so it's recalled on similar future issues">
                                                {m.saved ? '✓ saved to knowledge' : (savingIdx === i ? 'saving…' : '💡 Save as learning')}
                                            </button>
                                            {m.usage && (m.usage.inTok + m.usage.outTok) > 0 && (
                                                <span className="text-[10px] text-slate-400 ml-auto" title={`↑${m.usage.inTok} in · ↓${m.usage.outTok} out`}>
                                                    {((m.usage.inTok + m.usage.outTok) / 1000).toFixed(1)}k tok · ${m.usage.cost.toFixed(4)}
                                                </span>
                                            )}
                                            <button type="button" onClick={() => copyMessage(m.content)} className={`text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 ${m.usage ? '' : 'ml-auto'}`} title="Copy this answer">Copy</button>
                                        </div>
                                    )}
                                    {m.role === 'assistant' && learningIdx === i && (
                                        <div className="mt-2 flex items-center gap-2">
                                            <input
                                                autoFocus
                                                value={learningNote}
                                                onChange={(e) => setLearningNote(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') confirmSaveLearning(); if (e.key === 'Escape') setLearningIdx(null); }}
                                                placeholder="Actual fix / key takeaway to remember (optional)"
                                                className="flex-1 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                            />
                                            <button type="button" onClick={confirmSaveLearning} className="text-xs px-2 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Save</button>
                                            <button type="button" onClick={() => setLearningIdx(null)} className="text-xs px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500">Cancel</button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                        {busy && (
                            <div className="flex justify-start">
                                <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 px-4 py-3 text-sm">
                                    {toolEvents.length > 0 && !streamText && (
                                        <div className="mb-2 space-y-0.5">
                                            {toolEvents.map((t, idx) => (
                                                <div key={idx} className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                                                    <span className="text-indigo-500">🔧</span><span className="truncate">{t}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {streamText ? renderMarkdown(streamText, null) : (toolEvents.length === 0 && <span className="text-slate-400 animate-pulse">Thinking…</span>)}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Composer */}
                <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 p-3">
                    <div className="max-w-3xl mx-auto">
                        {attachments.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-2">
                                {attachments.map((a, idx) => (
                                    <span key={idx} className="inline-flex items-center gap-1 text-xs bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-md px-2 py-1">
                                        <span className="truncate max-w-[180px]">📎 {a.name}</span>
                                        <button type="button" onClick={() => removeAttachment(idx)} className="text-slate-400 hover:text-red-500">✕</button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="flex items-end gap-2">
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                onChange={onPickFiles}
                                className="hidden"
                                accept=".log,.txt,.lis,.csv,.json,.xml,.yaml,.yml,.out,.err,.zip,.xlsx,.xls,image/*"
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current && fileInputRef.current.click()}
                                title="Attach logs, screenshots, .xlsx/.zip, AWS/Datadog exports"
                                className="shrink-0 px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 text-base"
                            >
                                📎
                            </button>
                            <textarea
                                ref={inputRef}
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={onKeyDown}
                                rows={2}
                                placeholder="Describe the issue, paste case details / AWS / Datadog logs, or attach files… (Enter to send)"
                                className="flex-1 resize-none rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                            />
                            <button
                                type="button"
                                onClick={send}
                                disabled={busy || (!input.trim() && attachments.length === 0)}
                                className="shrink-0 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-medium transition-colors"
                            >
                                {busy ? '…' : 'Send'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
