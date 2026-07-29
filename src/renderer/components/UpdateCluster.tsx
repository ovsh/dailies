import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { UpdaterState } from "../../shared/types";

interface UpdateClusterProps {
  updateState: UpdaterState;
}

/**
 * Fixed top-right island inside the hidden-titlebar drag strip: an
 * always-visible version tag plus one button whose state mirrors
 * UpdaterState. See the approved mock, update-button-mock.html.
 *
 * "Up to date" is a transient renderer-only state layered on top of phase
 * "idle" — it only appears after a manual click, once lastCheckedAt moves
 * past the value it held when the click happened, and snaps back to plain
 * idle chrome after ~4s. Background checks (launch/hourly/focus) never
 * trigger it, since nothing here arms manualPendingRef for those.
 */
export function UpdateCluster({ updateState }: UpdateClusterProps) {
  const [showUpToDate, setShowUpToDate] = useState(false);
  const manualPendingRef = useRef(false);
  const armedLastCheckedAtRef = useRef<number | undefined>(undefined);

  const handleCheck = useCallback(() => {
    manualPendingRef.current = true;
    armedLastCheckedAtRef.current = updateState.lastCheckedAt;
    setShowUpToDate(false);
    void api.checkForUpdates();
  }, [updateState.lastCheckedAt]);

  useEffect(() => {
    if (!manualPendingRef.current) return;

    if (updateState.phase === "idle") {
      if (updateState.lastCheckedAt !== undefined && updateState.lastCheckedAt !== armedLastCheckedAtRef.current) {
        manualPendingRef.current = false;
        setShowUpToDate(true);
        const timer = setTimeout(() => setShowUpToDate(false), 4000);
        return () => clearTimeout(timer);
      }
      // Still waiting on the check to settle (or the updater is a dev no-op
      // that never moves lastCheckedAt) — stay armed, no visible change yet.
    } else if (
      updateState.phase === "downloading" ||
      updateState.phase === "staging" ||
      updateState.phase === "ready" ||
      updateState.phase === "error"
    ) {
      // Those phases render their own state; the manual arm is spent.
      manualPendingRef.current = false;
      setShowUpToDate(false);
    }
    return undefined;
  }, [updateState.phase, updateState.lastCheckedAt]);

  if (!updateState.currentVersion) return null;

  function renderButton() {
    if (showUpToDate) {
      return (
        <button type="button" className="check-btn quiet" disabled role="status" aria-label="Dailies is up to date">
          <span className="ok" aria-hidden="true">
            ✓
          </span>{" "}
          Up to date
        </button>
      );
    }

    switch (updateState.phase) {
      case "checking":
        return (
          <button type="button" className="check-btn quiet" disabled aria-label="Checking for updates">
            Checking
            <span className="dots" aria-hidden="true" />
          </button>
        );
      case "downloading": {
        const total = updateState.total;
        const transferred = updateState.transferred ?? 0;
        const pct = total ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
        return (
          <button
            type="button"
            className="check-btn quiet"
            disabled
            aria-label={`Downloading Dailies ${updateState.availableVersion ?? ""} — ${pct}%`}
          >
            Downloading{" "}
            <span className="bar" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
          </button>
        );
      }
      case "staging":
        return (
          <button
            type="button"
            className="check-btn quiet"
            disabled
            aria-label={`Preparing Dailies ${updateState.availableVersion ?? ""} — verifying the download`}
          >
            Preparing
            <span className="dots" aria-hidden="true" />
          </button>
        );
      case "ready":
        return (
          <button
            type="button"
            className="check-btn ready"
            onClick={() => void api.restartToUpdate()}
            aria-label={`Update ready — restart Dailies to install ${updateState.availableVersion ?? ""}`}
          >
            Restart · <span className="ver">{updateState.availableVersion}</span>
          </button>
        );
      case "error":
        return (
          <button
            type="button"
            className="check-btn error"
            onClick={handleCheck}
            aria-label={`Update check failed${updateState.errorMessage ? ` — ${updateState.errorMessage}` : ""} — retry`}
          >
            Check failed — retry
          </button>
        );
      case "idle":
      default:
        return (
          <button
            type="button"
            className="check-btn"
            onClick={handleCheck}
            aria-label={`Dailies ${updateState.currentVersion} — check for updates`}
          >
            Check for updates
          </button>
        );
    }
  }

  return (
    <div className="update-cluster">
      <span className="version-tag mono">v{updateState.currentVersion}</span>
      {renderButton()}
      <style>{`
        .update-cluster {
          position: fixed;
          top: 0;
          right: 10px;
          height: 34px;
          z-index: 41;
          display: flex;
          align-items: center;
          gap: 8px;
          pointer-events: auto;
          -webkit-app-region: no-drag;
          app-region: no-drag;
        }
        .version-tag {
          font-size: 11px;
          color: var(--ink-dim);
          letter-spacing: 0.02em;
        }
        .check-btn {
          font-family: var(--font-body);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--ink);
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          padding: 5px 10px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: background var(--dur-fast) var(--ease-out);
        }
        .check-btn:hover {
          background: #d2d6d9;
        }
        .check-btn:active {
          box-shadow: var(--bevel-in);
        }
        .check-btn.quiet {
          color: var(--ink-faint);
          cursor: default;
        }
        .check-btn.quiet:hover {
          background: var(--ground-raised);
        }

        /* checking: stepped ellipsis, chrome snaps, no easing */
        .dots::after {
          content: "";
          animation: update-cluster-dots 900ms steps(3, end) infinite;
        }
        @keyframes update-cluster-dots {
          0% {
            content: "";
          }
          33% {
            content: ".";
          }
          66% {
            content: "..";
          }
          100% {
            content: "...";
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .dots::after {
            content: "…";
            animation: none;
          }
        }

        .ok {
          color: var(--status-ok);
          font-weight: 800;
        }

        .bar {
          position: relative;
          width: 44px;
          height: 4px;
          background: var(--paper-alt);
          box-shadow: var(--bevel-in);
          overflow: hidden;
        }
        .bar i {
          position: absolute;
          top: 0;
          left: 0;
          bottom: 0;
          background: var(--accent);
        }

        .check-btn.ready {
          color: #fff;
          background: var(--marker-red);
          border-color: var(--marker-red-dn);
          font-weight: 800;
          box-shadow:
            inset 1px 1px 0 rgba(255, 255, 255, 0.25),
            inset -1px -1px 0 rgba(0, 0, 0, 0.2),
            1px 2px 0 rgba(23, 25, 27, 0.28);
        }
        .check-btn.ready:hover {
          background: #d24a41;
        }
        .check-btn.ready:active {
          box-shadow: inset 1px 1px 0 rgba(0, 0, 0, 0.2);
        }
        .check-btn.ready .ver {
          font-family: var(--font-mono);
          font-weight: 400;
          opacity: 0.9;
          text-transform: none;
        }

        .check-btn.error {
          color: var(--status-error);
        }
      `}</style>
    </div>
  );
}
