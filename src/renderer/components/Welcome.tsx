import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import {
  hasLlmAccessStatus,
  type AppSettings,
  type MediaRole,
  type ModelDownloadProgress,
  type ProjectFolder,
} from "../../shared/types";
import { InlineError } from "./InlineError";
import { runIpc } from "../lib/async";

interface WelcomeProps {
  settings: AppSettings;
  folders: ProjectFolder[];
  onSettingsChanged: () => void;
  onDismiss: () => void;
}

/** The four independent first-run checks, in bin-row order. */
type CheckId = "name" | "openrouter" | "folder" | "model";

const CHECK_ORDER: CheckId[] = ["name", "openrouter", "folder", "model"];

/**
 * First-run setup as a bin: three rows, every state visible at a glance.
 * The selected row opens its action drawer; selection follows the first
 * incomplete check, so exactly one action is on screen at a time.
 */
export function Welcome({ settings, folders, onSettingsChanged, onDismiss }: WelcomeProps) {
  const [operatorName, setOperatorName] = useState("");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [saving, setSaving] = useState<"name" | "openrouter" | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderRole, setFolderRole] = useState<MediaRole>("raw");
  const [modelProgress, setModelProgress] = useState<ModelDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [manualSelection, setManualSelection] = useState<CheckId | null>(null);
  const onSettingsChangedRef = useRef(onSettingsChanged);
  onSettingsChangedRef.current = onSettingsChanged;

  const llmAccessReady = hasLlmAccessStatus(settings.apiKeyStatus);
  const done: Record<CheckId, boolean> = {
    name: settings.operatorName !== null,
    openrouter: llmAccessReady,
    folder: folders.length > 0,
    model: settings.whisperModelReady,
  };
  const allReady = CHECK_ORDER.every((id) => done[id]);
  // A manually selected row holds focus until its check completes, then
  // selection falls back to the first incomplete check (auto-advance).
  const firstIncomplete = CHECK_ORDER.find((id) => !done[id]) ?? null;
  const selected = manualSelection && !done[manualSelection] ? manualSelection : firstIncomplete;

  useEffect(() => api.onModelProgress((progress) => {
    setModelProgress(progress);
    if (progress.error) setError(`Speech model download failed. ${progress.error}`);
    if (progress.done && !progress.error) {
      setRetryAction(null);
      onSettingsChangedRef.current();
    }
  }), []);

  async function saveName(name: string) {
    if (!name.trim()) return;
    setRetryAction(() => () => void saveName(name));
    const result = await runIpc(
      () => api.setOperatorName(name),
      {
        setPending: (pending) => setSaving(pending ? "name" : null),
        setError,
        fallback: "Could not save your name.",
      },
    );
    if (!result.ok) return;
    setOperatorName("");
    setRetryAction(null);
    onSettingsChanged();
  }

  async function saveKey(provider: "openrouter", key: string) {
    if (!key.trim()) return;
    setRetryAction(() => () => void saveKey(provider, key));
    const result = await runIpc(
      () => api.setApiKey(provider, key.trim()),
      {
        setPending: (pending) => setSaving(pending ? provider : null),
        setError,
        fallback: "Could not validate that OpenRouter key.",
      },
    );
    if (!result.ok) return;
    if (result.value === "invalid") {
      setError("OpenRouter rejected that API key. Check it and try again.");
      return;
    }
    if (result.value === "unavailable") {
      setError("OpenRouter could not be reached to validate the key. Check your connection and retry.");
      return;
    }
    setOpenRouterKey("");
    setRetryAction(null);
    onSettingsChanged();
  }

  async function chooseFolder(role: MediaRole) {
    setRetryAction(() => () => void chooseFolder(role));
    const result = await runIpc(
      () => api.addProjectFolder(role, null),
      { setPending: setAddingFolder, setError, fallback: "Could not add that footage folder." },
    );
    if (result.ok && result.value) {
      setRetryAction(null);
      onSettingsChanged();
    }
  }

  async function downloadModel() {
    setRetryAction(() => () => void downloadModel());
    setModelProgress({ downloadedMb: 0, totalMb: null, pct: 0, done: false, error: null });
    const result = await runIpc(api.downloadWhisperModel, {
      setError,
      fallback: "Could not start the speech model download.",
    });
    if (result.ok) setRetryAction(null);
  }

  const keyState = settings.apiKeyStatus === "managed"
    ? { label: "Provided for beta", tone: "ok" }
    : settings.apiKeyStatus === "connected"
      ? { label: "Connected", tone: "ok" }
    : settings.apiKeyStatus === "invalid"
      ? { label: "Invalid", tone: "error" }
      : settings.apiKeyStatus === "unavailable"
        ? { label: "Not verified", tone: "pending" }
        : { label: "Not connected", tone: "pending" };

  function row(
    id: CheckId,
    name: string,
    meta: string | null,
    state: { label: string; tone: string },
    drawer: ReactNode,
  ) {
    const isSelected = selected === id;
    return (
      <>
        <button
          type="button"
          className={`welcome-bin-row${isSelected ? " sel" : ""}`}
          onClick={() => setManualSelection(id)}
          disabled={done[id]}
          aria-expanded={isSelected}
        >
          <span className={`welcome-tick${done[id] ? " done" : ""}`} aria-hidden="true" />
          <span className="welcome-row-name">
            {name}
            {meta && <span className="welcome-row-meta mono">{meta}</span>}
          </span>
          <span className={`welcome-state ${state.tone}`}>{state.label}</span>
        </button>
        {isSelected && <div className="welcome-drawer">{drawer}</div>}
      </>
    );
  }

  return (
    <div className="welcome-overlay">
      <div className="welcome-panel">
        <div className="welcome-bar">
          <span className="welcome-bar-close" aria-hidden="true" />
          <span className="welcome-bar-title">Setup</span>
          <span className="welcome-bar-stripes" aria-hidden="true" />
        </div>
        <div className="welcome-body">
        <p className="welcome-mark display">Dailies</p>
        <p className="welcome-sub">
          Chat with your footage. Four independent setup checks. Continue now, or finish them later in Settings.
        </p>

        {error && (
          <InlineError
            message={error}
            onRetry={retryAction ?? undefined}
            retrying={saving !== null || addingFolder}
          />
        )}

        <div className="welcome-bin">
          <div className="welcome-bin-head">
            <span aria-hidden="true" />
            <span>Setup check</span>
            <span className="welcome-col-state">State</span>
          </div>

          {row(
            "name",
            "What's your name?",
            null,
            done.name
              ? { label: settings.operatorName ?? "Saved", tone: "ok" }
              : { label: "Not set", tone: "pending" },
            <>
              <p className="welcome-why">
                Labels this copy's diagnostics so we can tell testers apart when
                something breaks. First name is plenty.
              </p>
              <div className="welcome-row">
                <input
                  type="text"
                  className="welcome-input"
                  placeholder="Your name"
                  aria-label="Your name"
                  maxLength={40}
                  value={operatorName}
                  onChange={(e) => setOperatorName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void saveName(operatorName)}
                />
                <button
                  className="welcome-primary"
                  onClick={() => void saveName(operatorName)}
                  disabled={!operatorName.trim() || saving === "name"}
                >
                  {saving === "name" ? "Saving…" : "Save"}
                </button>
              </div>
            </>,
          )}

          {row(
            "openrouter",
            settings.apiKeyStatus === "managed" ? "AI models" : "OpenRouter API key",
            null,
            keyState,
            <>
              <p className="welcome-why">
                Powers the chat agents that search your transcripts and producer notes. Don't have a key?{" "}
                <button
                  className="text-link"
                  onClick={() => void api.openExternal("https://openrouter.ai/keys")}
                >
                  Create one at openrouter.ai/keys
                </button>
                . Free to sign up, takes about a minute, then paste it below.
              </p>
              <div className="welcome-row">
                <input
                  type="password"
                  className="welcome-input mono"
                  placeholder="sk-or-v1-…"
                  aria-label="OpenRouter API key"
                  value={openRouterKey}
                  onChange={(e) => setOpenRouterKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveKey("openrouter", openRouterKey)}
                />
                <button
                  className="welcome-primary"
                  onClick={() => saveKey("openrouter", openRouterKey)}
                  disabled={!openRouterKey.trim() || saving === "openrouter"}
                >
                  {saving === "openrouter" ? "Validating…" : "Validate & save"}
                </button>
              </div>
            </>,
          )}

          {row(
            "folder",
            "Footage folder",
            null,
            done.folder ? { label: "Watching", tone: "ok" } : { label: "Not selected", tone: "pending" },
            <>
              <p className="welcome-why">
                Point Dailies at a folder. Files are indexed in place, nothing is moved or copied, and
                new footage dropped in later is picked up automatically.
              </p>
              <div className="welcome-row">
                <div className="welcome-seg" role="group" aria-label="Folder role">
                  <button
                    type="button"
                    className={`welcome-seg-btn${folderRole === "raw" ? " on" : ""}`}
                    onClick={() => setFolderRole("raw")}
                  >
                    Raw footage
                  </button>
                  <button
                    type="button"
                    className={`welcome-seg-btn${folderRole === "final" ? " on" : ""}`}
                    onClick={() => setFolderRole("final")}
                  >
                    Finals
                  </button>
                </div>
                <button
                  className="welcome-primary"
                  onClick={() => void chooseFolder(folderRole)}
                  disabled={addingFolder}
                >
                  Choose folder…
                </button>
              </div>
              <p className="welcome-note">Most editors start with raw footage. Add a finals folder any time in Settings.</p>
            </>,
          )}

          {row(
            "model",
            "Speech model",
            "1.6 GB",
            done.model ? { label: "Downloaded", tone: "ok" } : { label: "Not downloaded", tone: "pending" },
            <>
              <p className="welcome-why">
                Transcribes dialogue locally. The {settings.whisperModel} model is a one-time download of about 1.6 GB.
              </p>
              {!settings.whisperAvailable && (
                <p className="welcome-prereq-note mono">The local Whisper engine is missing; transcription will remain unavailable.</p>
              )}
              {modelProgress && !modelProgress.done ? (
                <div className="welcome-model-row">
                  <span className="welcome-model-progress mono">
                    {modelProgress.pct !== null ? `${modelProgress.pct}% downloaded` : `${Math.round(modelProgress.downloadedMb)} MB downloaded`}
                  </span>
                </div>
              ) : (
                <button className="welcome-primary" onClick={() => void downloadModel()}>
                  Download speech model
                </button>
              )}
              {modelProgress && !modelProgress.done && modelProgress.pct !== null && (
                <div className="welcome-progress-bar">
                  <div className="welcome-progress-fill" style={{ transform: `scaleX(${modelProgress.pct / 100})` }} />
                </div>
              )}
            </>,
          )}
        </div>

        <div className="welcome-foot">
          <p>Dailies opens either way. Unfinished checks stay in Settings.</p>
          {allReady ? (
            <button className="welcome-primary welcome-enter" onClick={onDismiss}>Enter Dailies →</button>
          ) : (
            <button className="ghost-btn label welcome-enter" onClick={onDismiss}>Open Dailies →</button>
          )}
        </div>
        </div>
      </div>

      <style>{`
        .welcome-overlay {
          position: absolute;
          inset: 0;
          z-index: 100;
          background: var(--ground);
          background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.045) 0 1px, transparent 1px 7px);
          display: flex;
          align-items: flex-start;
          justify-content: center;
          overflow-y: auto;
          padding: 44px 24px;
        }
        .welcome-panel {
          width: 620px;
          max-width: 100%;
          height: fit-content;
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--bevel-out), 4px 6px 0 rgba(23, 25, 27, 0.28);
        }
        .welcome-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 7px 10px;
          box-shadow: inset 0 -1px 0 var(--chrome-lo);
          user-select: none;
        }
        .welcome-bar-close {
          width: 13px;
          height: 13px;
          flex: none;
          background: var(--ground-raised);
          box-shadow: var(--bevel-out);
          border: 1px solid var(--chrome-lo);
        }
        .welcome-bar-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .welcome-bar-stripes {
          flex: 1;
          height: 9px;
          background: repeating-linear-gradient(0deg, var(--chrome-lo) 0 1px, transparent 1px 3px);
          opacity: 0.5;
        }
        .welcome-body {
          background: var(--ground-card);
          border: 1px solid var(--chrome-lo);
          margin: 10px;
          padding: 24px 28px 26px;
        }
        .welcome-mark {
          font-size: 40px;
          color: var(--ink);
          margin: 0 0 10px;
          letter-spacing: -0.015em;
          line-height: 1;
        }
        .text-link {
          background: none;
          border: none;
          padding: 0;
          font: inherit;
          color: var(--accent);
          text-decoration: underline;
          cursor: pointer;
        }
        .text-link:hover {
          color: var(--accent-dim);
        }
        .welcome-sub {
          font-size: 13.5px;
          color: var(--ink-dim);
          line-height: 1.65;
          margin: 0 0 22px;
          max-width: 420px;
        }
        .welcome-bin {
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          background: var(--ground-card);
        }
        .welcome-bin-head {
          display: grid;
          grid-template-columns: 26px 1fr auto;
          align-items: center;
          gap: 12px;
          padding: 5px 10px;
          background: var(--paper-alt);
          border-bottom: 1px solid var(--hairline-strong);
        }
        .welcome-bin-head span {
          font-size: 9.5px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--ink-dimmer);
        }
        .welcome-col-state {
          justify-self: end;
        }
        .welcome-bin-row {
          width: 100%;
          display: grid;
          grid-template-columns: 26px 1fr auto;
          align-items: center;
          gap: 12px;
          padding: 9px 10px;
          background: transparent;
          border: 0;
          border-bottom: 1px solid var(--hairline);
          border-radius: 0;
          text-align: left;
          cursor: pointer;
          font: inherit;
        }
        .welcome-bin-row:last-child {
          border-bottom: 0;
        }
        .welcome-bin-row:disabled {
          cursor: default;
        }
        .welcome-bin-row:hover:not(.sel):not(:disabled) {
          background: var(--paper-alt);
        }
        .welcome-bin-row.sel {
          background: var(--select-bg);
        }
        .welcome-row-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--ink);
        }
        .welcome-bin-row.sel .welcome-row-name {
          color: var(--select-ink);
        }
        .welcome-row-meta {
          font-size: 10.5px;
          color: var(--ink-faint);
          margin-left: 8px;
        }
        .welcome-bin-row.sel .welcome-row-meta {
          color: #9aa1a8;
        }
        .welcome-state {
          font-size: 10.5px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .welcome-state.ok { color: var(--status-ok); }
        .welcome-state.pending { color: var(--status-warn); }
        .welcome-state.error { color: var(--status-error); }
        .welcome-bin-row.sel .welcome-state { color: var(--select-hit); }
        .welcome-tick {
          width: 13px;
          height: 13px;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
        }
        .welcome-tick.done {
          background: var(--status-ok);
          position: relative;
        }
        .welcome-tick.done::after {
          content: "";
          position: absolute;
          left: 3px;
          top: 1px;
          width: 4px;
          height: 8px;
          border: solid #fff;
          border-width: 0 2px 2px 0;
          transform: rotate(42deg);
        }
        .welcome-bin-row.sel .welcome-tick {
          border-color: #3d4348;
        }
        .welcome-drawer {
          background: #fff;
          border-bottom: 1px solid var(--hairline);
          box-shadow: inset 2px 0 0 var(--select-bg), var(--bevel-in);
          padding: 18px 18px 20px 22px;
        }
        .welcome-why {
          font-size: 12.5px;
          color: var(--ink-dimmer);
          line-height: 1.6;
          margin: 0 0 14px;
          max-width: 430px;
        }
        .welcome-note {
          font-size: 11.5px;
          color: var(--ink-dimmer);
          line-height: 1.5;
          margin: 10px 0 0;
          max-width: 430px;
        }
        .welcome-row {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        .welcome-input {
          flex: 1;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          color: var(--ink);
          font-size: 12.5px;
          padding: 9px 10px;
        }
        .welcome-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .welcome-input::placeholder {
          color: var(--ink-faint);
        }
        .welcome-primary {
          appearance: none;
          cursor: pointer;
          flex: none;
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          border-radius: 2px;
          color: #fff;
          font-family: var(--font-body);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          padding: 10px 18px;
          box-shadow: inset 1px 1px 0 rgba(255,255,255,.28), inset -1px -1px 0 rgba(0,0,0,.24), 2px 2px 0 rgba(23,25,27,.30);
        }
        .welcome-primary:hover:not(:disabled) {
          transform: translate(1px, 1px);
          box-shadow: inset 1px 1px 0 rgba(255,255,255,.28), inset -1px -1px 0 rgba(0,0,0,.24), 1px 1px 0 rgba(23,25,27,.30);
        }
        .welcome-primary:active:not(:disabled) {
          box-shadow: var(--bevel-in);
          transform: translate(1px, 1px);
        }
        .welcome-primary:disabled {
          cursor: default;
          opacity: 0.55;
        }
        .welcome-seg {
          display: inline-flex;
          flex: none;
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          overflow: hidden;
        }
        .welcome-seg-btn {
          appearance: none;
          cursor: pointer;
          background: var(--ground-raised);
          border: 0;
          color: var(--ink-dim);
          font-family: var(--font-body);
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          padding: 8px 14px;
        }
        .welcome-seg-btn + .welcome-seg-btn {
          border-left: 1px solid var(--chrome-lo);
        }
        .welcome-seg-btn:hover:not(.on) {
          background: #d2d6d9;
        }
        .welcome-seg-btn.on {
          background: var(--select-bg);
          color: var(--select-ink);
        }
        .welcome-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid var(--hairline);
        }
        .welcome-foot p {
          margin: 0;
          font-size: 12px;
          color: var(--ink-dimmer);
          max-width: 340px;
        }
        .welcome-prereq-note {
          color: var(--status-error);
          font-size: 10.5px;
          margin: -4px 0 12px;
        }
        .welcome-model-row {
          display: flex;
          align-items: center;
          min-height: 34px;
        }
        .welcome-model-progress {
          color: var(--accent);
          font-size: 11px;
        }
        .welcome-progress-bar {
          height: 10px;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          margin-top: 8px;
          overflow: hidden;
        }
        .welcome-progress-fill {
          height: 100%;
          background: repeating-linear-gradient(90deg, var(--accent) 0 6px, var(--accent-dim) 6px 12px);
          transform-origin: left;
          transition: transform 400ms var(--ease-out);
        }
        @media (prefers-reduced-motion: reduce) {
          .welcome-primary:hover:not(:disabled) { transform: none; }
        }
      `}</style>
    </div>
  );
}
