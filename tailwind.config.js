/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: 'class',
    content: ['./src/renderer/**/*.{html,js,jsx}'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
                mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
            },
            colors: {
                slack: { DEFAULT: '#4A154B', light: '#F4EFF4' },
                confluence: { DEFAULT: '#0052CC', light: '#DEEBFF' },
                snow: { DEFAULT: '#62D84E', light: '#EBF9E8' },
                website: { DEFAULT: '#FF6B35', light: '#FFF0EB' },
            },
            animation: {
                'fade-in': 'fadeIn 200ms ease-out',
                'slide-up': 'slideUp 250ms ease-out',
                'pulse-slow': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            },
            keyframes: {
                fadeIn: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
                slideUp: {
                    '0%': { opacity: 0, transform: 'translateY(6px)' },
                    '100%': { opacity: 1, transform: 'translateY(0)' },
                },
            },
            boxShadow: {
                'glow': '0 0 0 4px rgba(99, 102, 241, 0.15)',
                'card-hover-light': '0 8px 24px -4px rgba(15, 23, 42, 0.08)',
                'card-hover-dark': '0 8px 24px -4px rgba(0, 0, 0, 0.4)',
            },
        },
    },
    plugins: [require('@tailwindcss/forms')],
};
