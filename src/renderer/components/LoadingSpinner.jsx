import React from 'react';

export default function LoadingSpinner({ message = 'Searching...' }) {
    return (
        <div className="flex flex-col items-center justify-center py-16 gap-3 animate-fade-in">
            <div className="flex gap-1.5">
                {['bg-purple-500', 'bg-blue-500', 'bg-green-500', 'bg-sky-500', 'bg-indigo-500', 'bg-cyan-500'].map((color, index) => (
                    <div
                        key={color}
                        className={`w-2 h-2 rounded-full ${color} animate-bounce`}
                        style={{ animationDelay: `${index * 0.08}s`, animationDuration: '1s' }}
                    />
                ))}
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{message}</p>
        </div>
    );
}
