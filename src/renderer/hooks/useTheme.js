import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'perfectsearch:theme';

/**
 * Theme hook. Stores 'light' | 'dark' | 'system' in localStorage. When 'system'
 * the actual theme follows prefers-color-scheme and reacts to OS-level changes.
 * Applies the active theme as a class on <html> so Tailwind's class-based
 * dark mode picks it up everywhere.
 */
export function useTheme() {
    const [preference, setPreference] = useState(() => {
        try {
            return localStorage.getItem(STORAGE_KEY) || 'system';
        } catch (_) {
            return 'system';
        }
    });

    const apply = useCallback((pref) => {
        const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const useDark = pref === 'dark' || (pref === 'system' && systemDark);
        const root = document.documentElement;
        if (useDark) root.classList.add('dark'); else root.classList.remove('dark');
        return useDark;
    }, []);

    useEffect(() => {
        apply(preference);
        try { localStorage.setItem(STORAGE_KEY, preference); } catch (_) {}

        // If following the system, react to OS changes
        if (preference === 'system' && window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const handler = () => apply('system');
            mq.addEventListener('change', handler);
            return () => mq.removeEventListener('change', handler);
        }
        return undefined;
    }, [preference, apply]);

    const isDark = document.documentElement.classList.contains('dark');

    const cycle = useCallback(() => {
        // light → dark → system → light …
        setPreference((p) => (p === 'light' ? 'dark' : p === 'dark' ? 'system' : 'light'));
    }, []);

    return { preference, isDark, cycle, setPreference };
}
