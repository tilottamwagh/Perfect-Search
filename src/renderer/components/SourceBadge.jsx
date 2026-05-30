import React from 'react';

// Each source gets a tailwind class pair: a soft chip background for light mode
// and a glass tinted background for dark mode that pops without screaming.
const SOURCE_CONFIG = {
    Slack: { chip: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300 dark:ring-1 dark:ring-purple-500/30', dot: 'bg-purple-500' },
    Confluence: { chip: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-1 dark:ring-blue-500/30', dot: 'bg-blue-500' },
    ServiceNow: { chip: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300 dark:ring-1 dark:ring-green-500/30', dot: 'bg-green-500' },
    Atlassian: { chip: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-1 dark:ring-sky-500/30', dot: 'bg-sky-500' },
    Box: { chip: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-1 dark:ring-indigo-500/30', dot: 'bg-indigo-500' },
    Jira: { chip: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-1 dark:ring-cyan-500/30', dot: 'bg-cyan-500' },
    Resources: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-1 dark:ring-amber-500/30', dot: 'bg-amber-500' },
    Datadog: { chip: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-1 dark:ring-violet-500/30', dot: 'bg-violet-500' },
    AWS: { chip: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-1 dark:ring-orange-500/30', dot: 'bg-orange-500' },
    default: { chip: 'bg-slate-100 text-slate-800 dark:bg-slate-500/15 dark:text-slate-300 dark:ring-1 dark:ring-slate-500/30', dot: 'bg-slate-500' },
};

export default function SourceBadge({ source, type }) {
    const config = SOURCE_CONFIG[source] || SOURCE_CONFIG.default;
    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${config.chip}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
            {source}
            {type ? <span className="font-normal opacity-70 normal-case tracking-normal">· {type}</span> : null}
        </span>
    );
}
