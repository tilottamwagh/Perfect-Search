import React, { useEffect, useState } from 'react';

// Connectors that need a user-supplied instance URL. The packaged installer
// has no .env, so users must enter these in Settings on first run.
const URL_SOURCES = [
    {
        id: 'servicenow',
        label: 'ServiceNow',
        placeholder: 'https://yourcompany.service-now.com',
        help: 'Your ServiceNow instance URL — same as the URL bar when you log in via the web.',
    },
    {
        id: 'confluence',
        label: 'Confluence (Atlassian Cloud)',
        placeholder: 'https://yourcompany.atlassian.net',
        help: 'Your Atlassian site URL. Confluence and Jira usually share the same host.',
    },
    {
        id: 'jira',
        label: 'Jira',
        placeholder: 'https://yourcompany.atlassian.net',
        help: 'Jira host (often identical to Confluence).',
    },
    {
        id: 'atlassian',
        label: 'Atlassian Portal',
        placeholder: 'https://support.yourcompany.com',
        help: 'Your support / portal host if different from atlassian.net.',
    },
    {
        id: 'box',
        label: 'Box',
        placeholder: 'https://yourcompany.app.box.com',
        help: 'Your Box enterprise URL (leave blank for box.com default).',
    },
    {
        id: 'datadog',
        label: 'Datadog',
        placeholder: 'https://app.datadoghq.com',
        help: 'Your Datadog org URL — varies by region (datadoghq.com / datadoghq.eu / us3.datadoghq.com / etc.).',
    },
    {
        id: 'aws',
        label: 'AWS SSO start URL',
        placeholder: 'https://d-XXXXXXXX.awsapps.com/start/',
        help: 'Your IAM Identity Center start URL — find it in the Identity Center settings or your existing AWS-SSO bookmark.',
    },
];

export default function SettingsPanel({ reindexing, onReindex }) {
    const [configs, setConfigs] = useState({});
    const [drafts, setDrafts] = useState({});
    const [savingId, setSavingId] = useState(null);
    const [savedFlash, setSavedFlash] = useState(null);
    const [errors, setErrors] = useState({});

    // Load saved URLs once when the panel mounts.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const resp = await window.perfectsearch.listSourceConfigs();
                if (cancelled || !resp?.success) return;
                setConfigs(resp.configs || {});
                const initial = {};
                for (const src of URL_SOURCES) {
                    initial[src.id] = resp.configs?.[src.id]?.baseUrl || '';
                }
                setDrafts(initial);
            } catch (_) {
                /* ignore — first-run users will see empty fields */
            }
        })();
        return () => { cancelled = true; };
    }, []);

    async function handleSave(sourceId) {
        const value = (drafts[sourceId] || '').trim();
        setSavingId(sourceId);
        setErrors((prev) => ({ ...prev, [sourceId]: null }));
        try {
            const resp = await window.perfectsearch.saveSourceConfig(sourceId, { baseUrl: value });
            if (!resp.success) {
                setErrors((prev) => ({ ...prev, [sourceId]: resp.error || 'Save failed' }));
                return;
            }
            // Reflect the normalized value (https://, no trailing slash, etc.) back.
            const normalized = resp.config?.baseUrl || '';
            setDrafts((prev) => ({ ...prev, [sourceId]: normalized }));
            setConfigs((prev) => ({ ...prev, [sourceId]: { ...(prev[sourceId] || {}), baseUrl: normalized } }));
            setSavedFlash(sourceId);
            setTimeout(() => setSavedFlash((s) => (s === sourceId ? null : s)), 1600);
        } catch (err) {
            setErrors((prev) => ({ ...prev, [sourceId]: err.message }));
        } finally {
            setSavingId(null);
        }
    }

    return (
        <div className="max-w-3xl mx-auto px-6 pb-6 flex flex-col gap-5">
            {/* Connector instance URLs */}
            <section className="rounded-xl border border-slate-200 dark:border-slate-700/70 bg-white/60 dark:bg-slate-900/40 p-4">
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-1">
                    🔗 Connector instance URLs
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                    Enter your company's hosts. Required before connecting ServiceNow / Confluence / Jira.
                    Saved encrypted on this machine — nothing leaves your computer.
                </p>
                <div className="flex flex-col gap-3">
                    {URL_SOURCES.map((src) => {
                        const value = drafts[src.id] ?? '';
                        const saved = configs[src.id]?.baseUrl || '';
                        const isDirty = (value || '').trim() !== (saved || '').trim();
                        const err = errors[src.id];
                        const isSaving = savingId === src.id;
                        const justSaved = savedFlash === src.id;
                        return (
                            <div key={src.id} className="flex flex-col gap-1">
                                <label className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
                                    {src.label}
                                    {saved && (
                                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                                            saved
                                        </span>
                                    )}
                                </label>
                                <div className="flex gap-2 items-stretch">
                                    <input
                                        type="url"
                                        value={value}
                                        onChange={(e) => setDrafts((prev) => ({ ...prev, [src.id]: e.target.value }))}
                                        placeholder={src.placeholder}
                                        className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700
                                            bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100
                                            focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => handleSave(src.id)}
                                        disabled={isSaving || !isDirty}
                                        className="text-xs px-3 py-2 rounded-lg font-medium transition-colors
                                            bg-indigo-600 hover:bg-indigo-500 text-white
                                            disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-500"
                                    >
                                        {isSaving ? 'Saving…' : justSaved ? '✓ Saved' : 'Save'}
                                    </button>
                                </div>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">{src.help}</p>
                                {err && (
                                    <p className="text-[11px] text-rose-600 dark:text-rose-400">{err}</p>
                                )}
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* Maintenance actions */}
            <section className="flex gap-3">
                <button
                    type="button"
                    onClick={() => window.perfectsearch.clearCache()}
                    className="text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3.5 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors font-medium"
                >
                    🗑️ Clear cache
                </button>
                <button
                    type="button"
                    onClick={onReindex}
                    disabled={reindexing}
                    className="text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3.5 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors font-medium"
                >
                    {reindexing ? '⏳ Indexing…' : '🔄 Re-index website'}
                </button>
            </section>
        </div>
    );
}
