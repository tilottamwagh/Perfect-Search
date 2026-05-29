const reactPlugin = require('eslint-plugin-react');

module.exports = [
    {
        ignores: ['.webpack/**', 'out/**', 'node_modules/**'],
    },
    {
        files: ['src/**/*.js', 'src/**/*.jsx', 'tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                console: 'readonly',
                document: 'readonly',
                module: 'readonly',
                process: 'readonly',
                require: 'readonly',
                window: 'readonly',
                MAIN_WINDOW_WEBPACK_ENTRY: 'readonly',
                MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                setTimeout: 'readonly',
                URL: 'readonly',
            },
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },
        plugins: {
            react: reactPlugin,
        },
        settings: {
            react: {
                version: 'detect',
            },
        },
        rules: {
            'react/prop-types': 'off',
            'no-console': 'off',
        },
    },
];
