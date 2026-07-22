import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api";
import "./theme/global.css";

// Renderer failures land in the main-process session log (and from there in
// remote error reports). Guarded: in the browser preview `window.dailies`
// is absent and the mock's log() is a no-op.
window.addEventListener("error", (e) => {
  api.log("error", "ui", "ui.window.error", {
    error: e.message,
    stack: e.error instanceof Error ? e.error.stack : undefined,
    source: `${e.filename}:${e.lineno}`,
  });
});
window.addEventListener("unhandledrejection", (e) => {
  const reason: unknown = e.reason;
  api.log("error", "ui", "ui.unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

/** Last-resort catch for render crashes: log, show a plain reload screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    api.log("error", "ui", "ui.render_crash", {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <div className="titlebar-drag" />
        <p style={{ color: "var(--ink)", fontSize: 15 }}>Something went wrong displaying this screen.</p>
        <button
          style={{ background: "transparent", border: "1px solid var(--hairline-strong)", color: "var(--ink-dim)", padding: "7px 14px", borderRadius: 6 }}
          onClick={() => window.location.reload()}
        >
          Reload Dailies
        </button>
      </div>
    );
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root element");
}

createRoot(rootEl).render(
  <StrictMode>
    <div className="grain-overlay" />
    <div className="vignette-overlay" />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
