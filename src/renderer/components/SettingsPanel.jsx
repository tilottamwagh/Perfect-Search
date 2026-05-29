import React from 'react';

export default function SettingsPanel({ reindexing, onReindex }) {
    return (
        <div className="max-w-3xl mx-auto px-6 pb-6 flex gap-3">
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
        </div>
    );
}
