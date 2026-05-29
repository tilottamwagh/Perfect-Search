import React, { useEffect, useRef, useState } from 'react';
import debounce from 'lodash.debounce';

export default function SearchBar({ onSearch, isLoading, resultCount }) {
    const [query, setQuery] = useState('');
    const [focused, setFocused] = useState(false);
    const inputRef = useRef(null);
    const debouncedSearch = useRef(
        debounce((nextQuery) => {
            if (nextQuery.trim().length >= 2) {
                onSearch(nextQuery);
            }
        }, 400)
    ).current;

    useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

    useEffect(() => {
        const handler = (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                const el = inputRef.current;
                if (el) {
                    el.focus();
                    // Browser-address-bar behaviour: select existing text so
                    // typing replaces the current query instead of appending.
                    try { el.select(); } catch (_) { /* ignore */ }
                }
            }

            if (event.key === 'Escape') {
                debouncedSearch.cancel();
                setQuery('');
                onSearch('');
            }
        };

        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [debouncedSearch, onSearch]);

    const handleChange = (event) => {
        const value = event.target.value;
        setQuery(value);
        debouncedSearch(value);
    };

    const handleClear = () => {
        debouncedSearch.cancel();
        setQuery('');
        onSearch('');
        inputRef.current?.focus();
    };

    return (
        <div
            className={`relative flex items-center rounded-2xl border transition-all shadow-sm
                bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm
                ${focused
                    ? 'border-indigo-500 dark:border-indigo-400 shadow-indigo-500/15 dark:shadow-indigo-400/15 shadow-lg ring-4 ring-indigo-500/10 dark:ring-indigo-400/10'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}
            `}
        >
            <span className={`pl-5 text-lg transition-colors ${focused ? 'text-indigo-500 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}`}>🔍</span>
            <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={handleChange}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="Search across Slack, Confluence, ServiceNow, Atlassian, Box, Jira… (Ctrl+K)"
                className="flex-1 py-4 px-3 text-base bg-transparent outline-none
                    text-slate-900 dark:text-slate-100
                    placeholder-slate-400 dark:placeholder-slate-500"
                autoFocus
            />
            {isLoading ? (
                <span className="pr-4 text-xs text-slate-400 dark:text-slate-500 font-medium animate-pulse">Searching…</span>
            ) : resultCount !== null && query.trim() ? (
                <span className="pr-4 text-xs text-slate-500 dark:text-slate-400 font-mono font-medium">
                    {resultCount} {resultCount === 1 ? 'result' : 'results'}
                </span>
            ) : (
                <kbd className="pr-4 hidden sm:inline-block text-[10px] text-slate-400 dark:text-slate-500 font-mono font-semibold">
                    Ctrl+K
                </kbd>
            )}
            {query && !isLoading && (
                <button
                    type="button"
                    onClick={handleClear}
                    className="pr-4 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-lg leading-none transition-colors"
                    title="Clear (Esc)"
                >
                    ✕
                </button>
            )}
        </div>
    );
}
