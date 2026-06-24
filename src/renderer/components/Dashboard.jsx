import React, { useCallback, useEffect, useState } from 'react';
import Clock from './Clock';

const fmtTok = (n) => (n >= 1000000 ? `${(n / 1000000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const fmtUsd = (n) => `$${(Number(n) || 0).toFixed((n || 0) < 1 ? 4 : 2)}`;

function Card({ label, agg }) {
    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-800 dark:text-slate-100">{fmtUsd(agg.cost)}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{fmtTok(agg.tok)} tokens · {agg.count} calls</p>
        </div>
    );
}

export default function Dashboard() {
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        try {
            const r = await window.perfectsearch.usageSummary();
            if (r.success) setData({ summary: r.summary, pricing: r.pricing });
        } finally { setBusy(false); }
    }, []);

    useEffect(() => { load(); }, [load]);

    const clearAll = useCallback(async () => {
        await window.perfectsearch.usageClear();
        load();
    }, [load]);

    if (!data) {
        return <div className="flex-1 flex items-center justify-center text-slate-400">{busy ? 'Loading usage…' : 'No usage data yet.'}</div>;
    }

    const { summary } = data;
    const maxCost = Math.max(0.0001, ...summary.series.map((s) => s.cost));
    const features = Object.entries(summary.byFeature).sort((a, b) => b[1].cost - a[1].cost);
    const models = Object.entries(summary.byModel || {}).sort((a, b) => b[1].cost - a[1].cost);

    return (
        <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 dark:from-indigo-400 dark:via-purple-400 dark:to-pink-400 bg-clip-text text-transparent">AI Usage &amp; Cost</h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400">Tokens generated and money spent across all AI features.</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={load} className="text-xs px-3 py-1.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200">Refresh</button>
                        <button type="button" onClick={clearAll} className="text-xs px-3 py-1.5 rounded-md bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 hover:bg-red-100" title="Clear all usage records">Reset</button>
                    </div>
                </div>

                {/* Live clock + date */}
                <Clock />

                {/* Summary cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Card label="Today" agg={summary.today} />
                    <Card label="Last 7 days" agg={summary.last7} />
                    <Card label="Last 30 days" agg={summary.last30} />
                    <Card label="All time" agg={summary.all} />
                </div>

                {/* 30-day cost chart */}
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Daily spend — last 30 days</p>
                    <div className="flex items-end gap-[3px] h-32">
                        {summary.series.map((s) => (
                            <div key={s.day} className="flex-1 group relative flex flex-col justify-end" title={`${s.day}: ${fmtUsd(s.cost)} · ${fmtTok(s.tok)} tok`}>
                                <div
                                    className="w-full rounded-t bg-indigo-400/70 dark:bg-indigo-500/70 group-hover:bg-indigo-500"
                                    style={{ height: `${Math.max(2, (s.cost / maxCost) * 100)}%` }}
                                />
                            </div>
                        ))}
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                        <span>{summary.series[0] && summary.series[0].day.slice(5)}</span>
                        <span>{summary.series[summary.series.length - 1] && summary.series[summary.series.length - 1].day.slice(5)}</span>
                    </div>
                </div>

                {/* Breakdowns */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">By feature (all time)</p>
                        {features.length === 0 ? <p className="text-xs text-slate-400">No data</p> : features.map(([f, a]) => (
                            <div key={f} className="flex items-center justify-between text-sm py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <span className="text-slate-600 dark:text-slate-300">{f}</span>
                                <span className="text-slate-500 dark:text-slate-400">{fmtUsd(a.cost)} · {fmtTok(a.tok)}</span>
                            </div>
                        ))}
                    </div>
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">By model (all time)</p>
                        {models.length === 0 ? <p className="text-xs text-slate-400">No data</p> : models.map(([m, a]) => (
                            <div key={m} className="flex items-center justify-between text-sm py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
                                <span className="text-slate-600 dark:text-slate-300 truncate">{m}</span>
                                <span className="text-slate-500 dark:text-slate-400 shrink-0 ml-2">{fmtUsd(a.cost)} · {fmtTok(a.tok)}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <p className="text-[11px] text-slate-400">
                    {summary.recordCount} recorded calls. Costs use an editable pricing table (USD per 1M tokens) — verify against platform.openai.com/pricing for your models.
                </p>
            </div>
        </div>
    );
}
