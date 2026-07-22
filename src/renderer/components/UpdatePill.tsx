import { useEffect, useState } from "react";
import { api } from "../api";
import type { UpdateState } from "../../shared/types";

/**
 * Self-contained update affordance for the rail. Invisible until the
 * background check finds a newer version, then fades in once (no pulsing):
 * click to download (shows percent), click again to restart into the new
 * version. On a failed download it stays visible and offers a retry.
 */
export function UpdatePill() {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let mounted = true;
    void api.getUpdateState().then((s) => {
      if (mounted) setState(s);
    });
    const unsubscribe = api.onUpdateEvent(setState);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!state || !state.supported || !state.version) return null;
  if (state.phase !== "available" && state.phase !== "downloading" && state.phase !== "ready" && state.phase !== "error") {
    return null;
  }

  const tooltip =
    state.phase === "ready"
      ? `Restart to update to v${state.version}`
      : state.phase === "downloading"
        ? `Downloading v${state.version}…`
        : state.phase === "error"
          ? `Update to v${state.version} failed — click to retry`
          : `Update to v${state.version} — click to download`;

  function handleClick(): void {
    if (!state) return;
    if (state.phase === "ready") void api.installUpdate();
    else if (state.phase !== "downloading") void api.downloadUpdate();
  }

  return (
    <div className="update-pill-wrap">
      <button
        className={`update-pill${state.phase === "ready" ? " ready" : ""}`}
        onClick={handleClick}
        aria-label={tooltip}
        data-tooltip={tooltip}
        disabled={state.phase === "downloading"}
      >
        {state.phase === "downloading" ? (
          <span className="update-pill-pct mono">{state.percent ?? 0}%</span>
        ) : state.phase === "ready" ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M6.5 3.5v3.4h3.4" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 8v7M8.8 12.2 12 15.4l3.2-3.2" />
          </svg>
        )}
      </button>
      <style>{`
        .update-pill-wrap {
          margin-top: auto;
          padding-top: 12px;
        }
        .update-pill {
          position: relative;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: 1px solid var(--accent-dim);
          border-radius: 8px;
          color: var(--accent);
          animation: update-pill-in 600ms var(--ease-out) both;
          transition: background var(--dur-fast) var(--ease-out);
        }
        .update-pill:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.04);
        }
        .update-pill:disabled {
          cursor: default;
        }
        .update-pill svg {
          width: 19px;
          height: 19px;
        }
        .update-pill-pct {
          font-size: 9.5px;
          letter-spacing: 0.02em;
        }
        @keyframes update-pill-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .update-pill[data-tooltip]::after {
          content: attr(data-tooltip);
          position: absolute;
          left: calc(100% + 10px);
          top: 50%;
          transform: translateY(-50%) translateX(-4px);
          background: var(--ground-card);
          border: 1px solid var(--hairline-strong);
          color: var(--ink-dim);
          font-size: 11px;
          letter-spacing: 0.04em;
          white-space: nowrap;
          padding: 5px 9px;
          border-radius: 5px;
          opacity: 0;
          pointer-events: none;
          transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
          z-index: 20;
        }
        .update-pill[data-tooltip]:hover::after {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }
      `}</style>
    </div>
  );
}
