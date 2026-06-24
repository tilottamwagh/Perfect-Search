import React, { useEffect, useState } from 'react';

// Live analog + smart digital clock with today's date. Updates every second.
export default function Clock() {
    const [now, setNow] = useState(new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);

    const s = now.getSeconds();
    const m = now.getMinutes();
    const h = now.getHours();
    const secAngle = s * 6;
    const minAngle = m * 6 + s * 0.1;
    const hourAngle = (h % 12) * 30 + m * 0.5;

    const hh = ((h % 12) || 12);
    const ampm = h < 12 ? 'AM' : 'PM';
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(hh)}:${pad(m)}:${pad(s)}`;
    const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';

    // 12 hour ticks
    const ticks = [];
    for (let i = 0; i < 12; i += 1) {
        const a = (i * 30) * (Math.PI / 180);
        const outer = 52;
        const inner = i % 3 === 0 ? 42 : 46;
        ticks.push(
            <line
                key={i}
                x1={60 + inner * Math.sin(a)} y1={60 - inner * Math.cos(a)}
                x2={60 + outer * Math.sin(a)} y2={60 - outer * Math.cos(a)}
                stroke="currentColor" strokeWidth={i % 3 === 0 ? 2.5 : 1} strokeLinecap="round" opacity={i % 3 === 0 ? 0.8 : 0.4}
            />
        );
    }

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center gap-5">
            {/* Analog */}
            <svg viewBox="0 0 120 120" className="w-24 h-24 shrink-0 text-slate-500 dark:text-slate-400" xmlns="http://www.w3.org/2000/svg">
                <circle cx="60" cy="60" r="56" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                {ticks}
                {/* hour hand */}
                <line x1="60" y1="60" x2="60" y2="32" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"
                    className="text-slate-700 dark:text-slate-200" transform={`rotate(${hourAngle} 60 60)`} />
                {/* minute hand */}
                <line x1="60" y1="60" x2="60" y2="22" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                    className="text-slate-600 dark:text-slate-300" transform={`rotate(${minAngle} 60 60)`} />
                {/* second hand */}
                <line x1="60" y1="66" x2="60" y2="18" stroke="#6366f1" strokeWidth="1.3" strokeLinecap="round"
                    transform={`rotate(${secAngle} 60 60)`} />
                <circle cx="60" cy="60" r="3" fill="#6366f1" />
            </svg>

            {/* Smart digital */}
            <div className="min-w-0">
                <p className="text-xs text-slate-400">{greeting}</p>
                <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-bold tabular-nums tracking-tight text-slate-800 dark:text-slate-100">{timeStr}</span>
                    <span className="text-sm font-semibold text-indigo-500">{ampm}</span>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400">{dateStr}</p>
            </div>
        </div>
    );
}
