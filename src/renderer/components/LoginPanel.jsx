import React, { useState } from 'react';
import { connectorConfetti } from '../utils/confetti';

const SOURCES = [
    { id: 'slack', name: 'Slack', desc: 'Search messages and conversations', color: 'purple', login: () => window.perfectsearch.loginSlack() },
    { id: 'confluence', name: 'Confluence', desc: 'Search pages and blog posts', color: 'blue', login: () => window.perfectsearch.loginConfluence() },
    { id: 'servicenow', name: 'ServiceNow', desc: 'Search incidents and knowledge articles', color: 'green', login: () => window.perfectsearch.loginServiceNow() },
    { id: 'atlassian', name: 'Atlassian Portal', desc: 'Unified search across Confluence pages, Jira issues, and more', color: 'sky', login: () => window.perfectsearch.loginAtlassian() },
    { id: 'box', name: 'Box', desc: 'Search files and folders in your Box workspace', color: 'indigo', login: () => window.perfectsearch.loginBox() },
    { id: 'jira', name: 'Jira', desc: 'Search Jira issues, projects, and dashboards', color: 'cyan', login: () => window.perfectsearch.loginJira() },
    { id: 'resources', name: 'Ellucian Resources', desc: 'Search the Ellucian Resources portal — documentation, release notes, and announcements', color: 'amber', login: () => window.perfectsearch.loginResources() },
    { id: 'datadog', name: 'Datadog', desc: 'Jump into Log Explorer, Live Tail, or dashboards with your query pre-applied', color: 'violet', login: () => window.perfectsearch.loginDatadog() },
    { id: 'aws', name: 'AWS', desc: 'Search the AWS Console and CloudWatch log groups via IAM Identity Center SSO', color: 'orange', login: () => window.perfectsearch.loginAws() },
];

const COLOR = {
    purple: { ring: 'ring-purple-500 dark:ring-purple-400', btn: 'bg-purple-600 hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600', tag: 'bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-300' },
    blue: { ring: 'ring-blue-500 dark:ring-blue-400', btn: 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600', tag: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300' },
    green: { ring: 'ring-green-500 dark:ring-green-400', btn: 'bg-green-600 hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600', tag: 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300' },
    sky: { ring: 'ring-sky-500 dark:ring-sky-400', btn: 'bg-sky-600 hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600', tag: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300' },
    indigo: { ring: 'ring-indigo-500 dark:ring-indigo-400', btn: 'bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600', tag: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300' },
    cyan: { ring: 'ring-cyan-500 dark:ring-cyan-400', btn: 'bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-500 dark:hover:bg-cyan-600', tag: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-300' },
    amber: { ring: 'ring-amber-500 dark:ring-amber-400', btn: 'bg-amber-600 hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600', tag: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' },
    violet: { ring: 'ring-violet-500 dark:ring-violet-400', btn: 'bg-violet-600 hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600', tag: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300' },
    orange: { ring: 'ring-orange-500 dark:ring-orange-400', btn: 'bg-orange-600 hover:bg-orange-700 dark:bg-orange-500 dark:hover:bg-orange-600', tag: 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300' },
};

const PROVIDER_COLOR = {
    amber: 'from-amber-50/60 via-white to-orange-50/40 dark:from-amber-950/30 dark:via-slate-900/60 dark:to-orange-950/20 border-amber-200/70 dark:border-amber-800/40',
    rose: 'from-rose-50/60 via-white to-pink-50/40 dark:from-rose-950/30 dark:via-slate-900/60 dark:to-pink-950/20 border-rose-200/70 dark:border-rose-800/40',
    emerald: 'from-emerald-50/60 via-white to-teal-50/40 dark:from-emerald-950/30 dark:via-slate-900/60 dark:to-emerald-950/20 border-emerald-200/70 dark:border-emerald-800/40',
    sky: 'from-sky-50/60 via-white to-cyan-50/40 dark:from-sky-950/30 dark:via-slate-900/60 dark:to-cyan-950/20 border-sky-200/70 dark:border-sky-800/40',
    cyan: 'from-cyan-50/60 via-white to-teal-50/40 dark:from-cyan-950/30 dark:via-slate-900/60 dark:to-teal-950/20 border-cyan-200/70 dark:border-cyan-800/40',
};
const PROVIDER_BADGE = {
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
    rose: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300',
    emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
    sky: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
    cyan: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-300',
};

function AiProviderRow({ provider, active, onChange }) {
    const [value, setValue] = React.useState('');
    const [selectedModel, setSelectedModel] = React.useState(provider.activeModel || provider.defaultModel);
    const [busy, setBusy] = React.useState(false);
    const [msg, setMsg] = React.useState(null);
    // Collapsed by default so the settings panel reads as a tidy list. Users
    // expand whichever provider they want to configure or inspect.
    const [expanded, setExpanded] = React.useState(false);
    const isActive = active === provider.id;

    React.useEffect(() => {
        setSelectedModel(provider.activeModel || provider.defaultModel);
    }, [provider.activeModel, provider.defaultModel]);

    const save = async () => {
        setBusy(true); setMsg(null);
        const resp = await window.perfectsearch.saveAiKey(provider.id, value, selectedModel);
        setBusy(false);
        if (resp.success) {
            setValue(''); setMsg({ ok: true, text: `Saved (${resp.model})` });
            setTimeout(() => setMsg(null), 2500);
            onChange();
        } else {
            setMsg({ ok: false, text: resp.error || 'Failed to save key' });
        }
    };

    const clear = async () => {
        await window.perfectsearch.clearAiKey(provider.id);
        setMsg(null);
        onChange();
    };

    const makeActive = async () => {
        await window.perfectsearch.setActiveAiProvider(provider.id);
        onChange();
    };

    // Custom-model entry: when the user picks "Custom…" from the dropdown we
    // reveal a free text field so they can type ANY model id the provider
    // supports — including brand-new ones not in our curated list. The model
    // list goes stale fast; this future-proofs it.
    const modelIds = Array.isArray(provider.models) ? provider.models.map((m) => m.id) : [];
    const isCustomModel = Boolean(selectedModel) && !modelIds.includes(selectedModel);
    const [customMode, setCustomMode] = React.useState(isCustomModel);
    const [customDraft, setCustomDraft] = React.useState(isCustomModel ? selectedModel : '');

    React.useEffect(() => {
        // Keep custom mode in sync if the saved model isn't in the list.
        if (isCustomModel) { setCustomMode(true); setCustomDraft(selectedModel); }
    }, [isCustomModel, selectedModel]);

    const changeModel = async (newModel) => {
        setSelectedModel(newModel);
        // If the user already has a key configured, persist the model change
        // immediately. If not, we'll save it when they save the key.
        if (provider.configured) {
            await window.perfectsearch.saveAiModel(provider.id, newModel);
            setMsg({ ok: true, text: `Model changed to ${newModel}` });
            setTimeout(() => setMsg(null), 2000);
            onChange();
        }
    };

    const onModelSelect = (val) => {
        if (val === '__custom__') {
            setCustomMode(true);
            setCustomDraft(isCustomModel ? selectedModel : '');
            return;
        }
        setCustomMode(false);
        changeModel(val);
    };

    const commitCustomModel = async () => {
        const m = customDraft.trim();
        if (!m) return;
        await changeModel(m);
    };

    // Reasoning effort (OpenAI gpt-5 / o-series only).
    const [reasoning, setReasoning] = React.useState(provider.reasoning || 'medium');
    React.useEffect(() => { setReasoning(provider.reasoning || 'medium'); }, [provider.reasoning]);
    const changeReasoning = async (level) => {
        setReasoning(level);
        await window.perfectsearch.saveAiReasoning(provider.id, level);
        setMsg({ ok: true, text: `Reasoning set to ${level}` });
        setTimeout(() => setMsg(null), 2000);
        onChange();
    };

    const gradient = PROVIDER_COLOR[provider.color] || PROVIDER_COLOR.amber;
    const badge = PROVIDER_BADGE[provider.color] || PROVIDER_BADGE.amber;

    return (
        <div className={`rounded-xl border bg-gradient-to-br ${gradient} transition-all`}>
            {/* Header row — always visible. The whole row toggles expansion
                (except the action buttons themselves, which stopPropagation). */}
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="w-full text-left p-4 flex items-center justify-between gap-3 cursor-pointer"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${provider.name} settings`}
            >
                <div className="flex-1 min-w-0 flex items-center flex-wrap gap-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{provider.name}</span>
                    {provider.configured && (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${badge}`}>Configured</span>
                    )}
                    {isActive && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-indigo-100 text-indigo-800 dark:bg-indigo-500/25 dark:text-indigo-300">
                            ✨ Active
                        </span>
                    )}
                    {provider.supportsWeb && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300" title="Supports web research">
                            🌐 web
                        </span>
                    )}
                    {/* When collapsed, surface the active model so users see at a
                        glance what's selected without expanding. */}
                    {!expanded && provider.configured && (
                        <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono ml-1 truncate">
                            {selectedModel}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {provider.configured && !isActive && (
                        <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); makeActive(); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); makeActive(); } }}
                            className="text-[11px] text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 px-3 py-1 rounded-md font-medium transition-colors"
                        >
                            Use this
                        </span>
                    )}
                    {provider.configured && (
                        <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); clear(); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); clear(); } }}
                            className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-red-500 dark:hover:text-red-400 border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-700 px-3 py-1 rounded-md transition-colors"
                        >
                            Remove
                        </span>
                    )}
                    {/* Chevron — rotates 180° when expanded so it points up,
                        signalling "click to collapse". */}
                    <span
                        className={`text-slate-400 dark:text-slate-500 text-base leading-none inline-block transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                    >
                        ▾
                    </span>
                </div>
            </button>

            {/* Expanded body — description, model picker, key input, messages. */}
            {expanded && (
                <div className="px-4 pb-4 -mt-1 flex flex-col gap-3 animate-fade-in">
                    <div>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{provider.keyHelp}</p>
                        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{provider.pricing}</p>
                    </div>

                    {Array.isArray(provider.models) && provider.models.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-2">
                                <label className="text-[11px] text-slate-500 dark:text-slate-400 font-medium shrink-0">Model</label>
                                <select
                                    value={customMode ? '__custom__' : selectedModel}
                                    onChange={(e) => onModelSelect(e.target.value)}
                                    className="flex-1 text-xs font-mono px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500 dark:focus:border-indigo-400"
                                >
                                    {provider.models.map((m) => (
                                        <option key={m.id} value={m.id}>
                                            {m.label} · {m.tier}
                                        </option>
                                    ))}
                                    <option value="__custom__">✏️ Custom model…</option>
                                </select>
                            </div>
                            {customMode && (
                                <div className="flex items-center gap-2 pl-[44px]">
                                    <input
                                        type="text"
                                        value={customDraft}
                                        onChange={(e) => setCustomDraft(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') commitCustomModel(); }}
                                        placeholder="exact model id, e.g. gemini-3.0-pro"
                                        className="flex-1 text-xs font-mono px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500 dark:focus:border-indigo-400"
                                    />
                                    <button
                                        type="button"
                                        onClick={commitCustomModel}
                                        disabled={!customDraft.trim() || customDraft.trim() === selectedModel}
                                        className="text-[11px] text-white px-3 py-1.5 rounded-md font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40"
                                    >
                                        Use
                                    </button>
                                </div>
                            )}
                            {customMode && (
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 pl-[44px]">
                                    Type any model the provider supports — the exact API id. If it's wrong, synthesis will return a clear error.
                                </p>
                            )}

                            {/* Reasoning effort — only for OpenAI gpt-5 / o-series.
                                Mirrors the "Reasoning: Medium" control in IDE-style
                                settings. Higher = deeper thinking, slower, more tokens. */}
                            {provider.supportsReasoning && /^(o\d|gpt-5)/i.test(selectedModel) && (
                                <div className="flex items-center gap-2">
                                    <label className="text-[11px] text-slate-500 dark:text-slate-400 font-medium shrink-0">Reasoning</label>
                                    <select
                                        value={reasoning}
                                        onChange={(e) => changeReasoning(e.target.value)}
                                        className="text-xs px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500 dark:focus:border-indigo-400"
                                    >
                                        <option value="minimal">Minimal — fastest, least thinking</option>
                                        <option value="low">Low</option>
                                        <option value="medium">Medium — balanced (default)</option>
                                        <option value="high">High — deepest, slowest</option>
                                    </select>
                                </div>
                            )}
                        </div>
                    )}

                    {!provider.configured && (
                        <div className="flex gap-2">
                            <input
                                type="password"
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                placeholder={`${provider.keyPrefix}…`}
                                className="flex-1 text-xs font-mono px-3 py-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-500 dark:focus:border-indigo-400"
                            />
                            <button
                                type="button"
                                onClick={save}
                                disabled={busy || value.length < 20}
                                className="text-xs text-white px-4 py-2 rounded-md font-semibold bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 transition-all shadow-sm shadow-indigo-500/25"
                            >
                                {busy ? 'Testing…' : 'Save'}
                            </button>
                        </div>
                    )}

                    {msg && (
                        <p className={`text-xs ${msg.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{msg.text}</p>
                    )}
                </div>
            )}
        </div>
    );
}

function AiKeyCard() {
    const [providers, setProviders] = React.useState([]);
    const [active, setActive] = React.useState(null);

    const refresh = React.useCallback(async () => {
        const resp = await window.perfectsearch.getAiProviders();
        setProviders(resp.providers || []);
        setActive(resp.active || null);
    }, []);

    React.useEffect(() => { refresh(); }, [refresh]);

    return (
        <div className="rounded-xl border p-4 flex flex-col gap-3 bg-gradient-to-br from-indigo-50/60 via-white to-purple-50/40 dark:from-indigo-950/30 dark:via-slate-900/60 dark:to-purple-950/20 border-indigo-200/70 dark:border-indigo-800/40">
            <div className="flex items-center gap-2 mb-1">
                <span className="text-base">✨</span>
                <span className="font-semibold text-slate-900 dark:text-slate-100">PerfectSearch AI providers</span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 ml-auto">Configure any one or more. The "Active" provider handles AI synthesis.</span>
            </div>
            <div className="flex flex-col gap-2.5">
                {providers.map((p) => (
                    <AiProviderRow key={p.id} provider={p} active={active} onChange={refresh} />
                ))}
            </div>
        </div>
    );
}

export default function LoginPanel({ authStatus, onAuthChange }) {
    const [loading, setLoading] = useState({});
    const [errors, setErrors] = useState({});

    async function handleLogin(source) {
        setLoading((current) => ({ ...current, [source.id]: true }));
        setErrors((current) => ({ ...current, [source.id]: null }));

        try {
            const result = await source.login();
            if (result.success) {
                connectorConfetti(source.color);
                await onAuthChange();
            } else {
                setErrors((current) => ({ ...current, [source.id]: result.error }));
            }
        } catch (error) {
            setErrors((current) => ({ ...current, [source.id]: error.message }));
        } finally {
            setLoading((current) => ({ ...current, [source.id]: false }));
        }
    }

    async function handleLogout(sourceId) {
        await window.perfectsearch.logout(sourceId);
        await onAuthChange();
    }

    return (
        <div className="max-w-3xl mx-auto p-6">
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-1">Connect your sources</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">Log in with your enterprise SSO credentials. Captured sessions stay on your machine.</p>
            <div className="mb-3">
                <AiKeyCard />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {SOURCES.map((source) => {
                    const connected = authStatus[source.id];
                    const color = COLOR[source.color];

                    return (
                        <div
                            key={source.id}
                            className={`rounded-xl border p-4 flex items-center gap-4 transition-all
                                bg-white dark:bg-slate-900/60 backdrop-blur-sm
                                ${connected
                                    ? `ring-2 ${color.ring} border-transparent shadow-sm`
                                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`}
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                    <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">{source.name}</span>
                                    {connected && <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${color.tag}`}>Connected</span>}
                                </div>
                                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{source.desc}</p>
                                {!connected && errors[source.id] && <p className="text-xs text-red-500 dark:text-red-400 mt-1">{errors[source.id]}</p>}
                            </div>

                            {connected ? (
                                <button
                                    type="button"
                                    onClick={() => handleLogout(source.id)}
                                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-red-500 dark:hover:text-red-400 border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-700 px-3 py-1.5 rounded-lg transition-colors"
                                >
                                    Disconnect
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => handleLogin(source)}
                                    disabled={loading[source.id]}
                                    className={`text-xs text-white px-4 py-1.5 rounded-lg font-semibold shadow-sm transition-all hover:shadow-md ${color.btn} disabled:opacity-50 disabled:hover:shadow-sm`}
                                >
                                    {loading[source.id] ? 'Opening…' : 'Connect'}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
