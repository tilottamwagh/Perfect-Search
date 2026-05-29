import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    render() {
        if (this.state.error) {
            return (
                <div className="p-8 text-center">
                    <p className="text-red-600 dark:text-red-400 font-semibold text-lg">Something went wrong</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{this.state.error.message}</p>
                    <button
                        type="button"
                        onClick={() => this.setState({ error: null })}
                        className="mt-4 text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        Try again
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}

const root = createRoot(document.getElementById('root'));
root.render(
    <ErrorBoundary>
        <App />
    </ErrorBoundary>
);
