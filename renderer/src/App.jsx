import React from "react";
import ControlPage from "./pages/ControlPage";
import CliPage from "./pages/CliPage";

class RendererErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try {
      console.error("[renderer] uncaught render error", error, info);
    } catch {}
  }

  render() {
    if (this.state.error) {
      const message =
        this.state.error?.stack || this.state.error?.message || String(this.state.error);
      return (
        <main className="shell p-4">
          <section className="card space-y-3 !bg-[#0b1116] border border-error/50">
            <div className="text-lg font-semibold text-error">Renderer crashed</div>
            <div className="text-sm text-slate-300">
              The UI hit an unhandled error. Copy this and share it.
            </div>
            <pre className="text-xs whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/20 p-3 text-slate-200">
              {message}
            </pre>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-gradient btn-sm"
                onClick={() => window.location.reload()}
              >
                Reload UI
              </button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const isCli = window.location.hash === "#/cli";
  return (
    <RendererErrorBoundary>
      {isCli ? <CliPage /> : <ControlPage />}
    </RendererErrorBoundary>
  );
}
