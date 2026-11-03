import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Dashboard caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 max-w-xl mx-auto my-12 bg-zinc-900 border border-red-500/30 rounded-lg text-zinc-200">
          <h2 className="text-lg font-semibold text-red-400 mb-2">Something went wrong</h2>
          <p className="text-xs text-zinc-400 font-mono bg-zinc-950 p-3 rounded border border-zinc-800 mb-4 whitespace-pre-wrap break-words">
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition"
            >
              Reload page
            </button>
            <a
              href="/admin/users"
              className="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition"
            >
              ← Back to Users
            </a>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
