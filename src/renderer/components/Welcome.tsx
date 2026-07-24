import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AppSettings, MediaRole, ModelDownloadProgress, ProjectFolder } from "../../shared/types";
import { InlineError } from "./InlineError";
import { runIpc } from "../lib/async";

interface WelcomeProps {
  settings: AppSettings;
  folders: ProjectFolder[];
  onSettingsChanged: () => void;
  onDismiss: () => void;
}

/**
 * First-run setup. Each requirement is independent and reports its real state.
 */
export function Welcome({ settings, folders, onSettingsChanged, onDismiss }: WelcomeProps) {
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [saving, setSaving] = useState<"openrouter" | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [modelProgress, setModelProgress] = useState<ModelDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const onSettingsChangedRef = useRef(onSettingsChanged);
  onSettingsChangedRef.current = onSettingsChanged;

  const keyConnected = settings.apiKeyStatus === "connected";
  const allReady = keyConnected && folders.length > 0 && settings.whisperModelReady;

  useEffect(() => api.onModelProgress((progress) => {
    setModelProgress(progress);
    if (progress.error) setError(`Speech model download failed. ${progress.error}`);
    if (progress.done && !progress.error) {
      setRetryAction(null);
      onSettingsChangedRef.current();
    }
  }), []);

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

  return (
    <div className="welcome-overlay">
      <div className="welcome-panel">
        <p className="welcome-mark display">Dailies</p>
        <p className="welcome-sub">
          Chat with your footage. Three independent setup checks. Continue now, or finish them later in Settings.
        </p>

        {error && (
          <InlineError
            message={error}
            onRetry={retryAction ?? undefined}
            retrying={saving !== null || addingFolder}
          />
        )}

        <div className="welcome-step">
          <div className="welcome-step-head">
            <span className="welcome-step-num mono">01</span>
            <span className="label">OpenRouter API key</span>
            <span className={`welcome-check${keyConnected ? "" : " missing"}`}>
              {keyConnected ? "connected" : settings.apiKeyStatus === "invalid" ? "invalid" : settings.apiKeyStatus === "unavailable" ? "not verified" : "not connected"}
            </span>
          </div>
          <p className="welcome-step-why">
            Powers the chat agents that search your transcripts and producer notes. Don't have a key?{" "}
            <button
              className="text-link"
              onClick={() => void api.openExternal("https://openrouter.ai/keys")}
            >
              Create one at openrouter.ai/keys
            </button>
            . Free to sign up, takes about a minute, then paste it below.
          </p>
          {!keyConnected && (
            <div className="welcome-row">
              <input
                type="password"
                className="welcome-input mono"
                placeholder="sk-or-v1-…"
                value={openRouterKey}
                onChange={(e) => setOpenRouterKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveKey("openrouter", openRouterKey)}
              />
              <button
                className="ghost-btn label"
                onClick={() => saveKey("openrouter", openRouterKey)}
                disabled={!openRouterKey.trim() || saving === "openrouter"}
              >
                {saving === "openrouter" ? "Validating…" : "Validate & save"}
              </button>
            </div>
          )}
        </div>

        <div className="welcome-step">
          <div className="welcome-step-head">
            <span className="welcome-step-num mono">02</span>
            <span className="label">Footage folder</span>
            <span className={`welcome-check${folders.length > 0 ? "" : " missing"}`}>
              {folders.length > 0 ? "watching" : "not selected"}
            </span>
          </div>
          <p className="welcome-step-why">
            Point Dailies at a folder. Files are indexed in place, nothing is moved or copied, and
            new footage dropped in later is picked up automatically.
          </p>
          {folders.map((f) => (
            <p key={f.id} className="welcome-folder mono">
              <span className="welcome-folder-role label">{f.role === "raw" ? "RAW" : "FINAL"}</span>
              {f.path}
            </p>
          ))}
          <div className="welcome-folder-btns">
            <button className="ghost-btn label" onClick={() => chooseFolder("raw")} disabled={addingFolder}>
              Choose raw footage folder…
            </button>
            <button className="ghost-btn label" onClick={() => chooseFolder("final")} disabled={addingFolder}>
              Choose finals folder…
            </button>
          </div>
        </div>

        <div className="welcome-step">
          <div className="welcome-step-head">
            <span className="welcome-step-num mono">03</span>
            <span className="label">Speech model</span>
            <span className={`welcome-check${settings.whisperModelReady ? "" : " missing"}`}>
              {settings.whisperModelReady ? "downloaded" : "not downloaded"}
            </span>
          </div>
          <p className="welcome-step-why">
            Transcribes dialogue locally. The {settings.whisperModel} model is a one-time download of about 1.6 GB.
          </p>
          {!settings.whisperAvailable && (
            <p className="welcome-prereq-note mono">The local Whisper engine is missing; transcription will remain unavailable.</p>
          )}
          {!settings.whisperModelReady && (
            <div className="welcome-model-row">
              {modelProgress && !modelProgress.done ? (
                <span className="welcome-model-progress mono">
                  {modelProgress.pct !== null ? `${modelProgress.pct}% downloaded` : `${Math.round(modelProgress.downloadedMb)} MB downloaded`}
                </span>
              ) : (
                <button className="ghost-btn label" onClick={() => void downloadModel()}>
                  Download speech model
                </button>
              )}
            </div>
          )}
          {modelProgress && !modelProgress.done && modelProgress.pct !== null && (
            <div className="welcome-progress-bar">
              <div className="welcome-progress-fill" style={{ transform: `scaleX(${modelProgress.pct / 100})` }} />
            </div>
          )}
        </div>

        <div className="welcome-footer">
          {!allReady && (
            <p className="welcome-limitations mono">
              {!keyConnected && "Without a validated OpenRouter key, chat and semantic search will wait. "}
              {folders.length === 0 && "Without a footage folder, there is nothing to index. "}
              {!settings.whisperModelReady && "Without the speech model, transcription will wait."}
            </p>
          )}
          <button className="welcome-enter" onClick={onDismiss}>
            {allReady ? "Enter Dailies →" : "Continue with missing setup →"}
          </button>
        </div>
      </div>

      <style>{`
        .welcome-overlay {
          position: absolute;
          inset: 0;
          z-index: 100;
          background: var(--ground);
          display: flex;
          align-items: flex-start;
          justify-content: center;
          overflow-y: auto;
          animation: fade-in var(--dur-med) var(--ease-out) both;
        }
        .welcome-panel {
          width: 560px;
          max-width: calc(100vw - 96px);
          padding: 48px 0;
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .welcome-mark {
          font-size: 44px;
          color: var(--ink);
          margin: 0 0 10px;
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
          margin: 0 0 40px;
          max-width: 400px;
        }
        .welcome-step {
          padding: 22px 0;
          border-top: 1px solid var(--hairline);
        }
        .welcome-step-head {
          display: flex;
          align-items: baseline;
          gap: 12px;
          margin-bottom: 6px;
        }
        .welcome-step-num {
          font-size: 11px;
          color: var(--accent-dim);
        }
        .welcome-check {
          margin-left: auto;
          font-size: 10.5px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--status-ok);
        }
        .welcome-check.missing {
          color: var(--status-warn);
        }
        .welcome-step-why {
          font-size: 12.5px;
          color: var(--ink-dimmer);
          line-height: 1.6;
          margin: 0 0 14px;
          max-width: 400px;
        }
        .welcome-row {
          display: flex;
          gap: 10px;
        }
        .welcome-input {
          flex: 1;
          background: transparent;
          border: none;
          border-bottom: 1px solid var(--hairline-strong);
          color: var(--ink);
          font-size: 12.5px;
          padding: 8px 0;
          transition: border-color var(--dur-fast) var(--ease-out);
        }
        .welcome-input:focus {
          outline: none;
          border-color: var(--accent-dim);
        }
        .welcome-input::placeholder {
          color: var(--ink-faint);
        }
        .welcome-folder {
          display: flex;
          align-items: baseline;
          gap: 10px;
          font-size: 11.5px;
          color: var(--ink-dim);
          margin: 0 0 10px;
        }
        .welcome-folder-role {
          color: var(--ink-dimmer);
          font-size: 9.5px;
        }
        .welcome-folder-btns {
          display: flex;
          gap: 10px;
        }
        .welcome-footer {
          border-top: 1px solid var(--hairline);
          padding-top: 28px;
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 24px;
        }
        .welcome-limitations {
          color: var(--ink-dimmer);
          font-size: 10.5px;
          line-height: 1.55;
          margin: 0;
          max-width: 350px;
        }
        .welcome-model-row {
          display: flex;
          align-items: center;
          min-height: 34px;
        }
        .welcome-prereq-note {
          color: var(--status-error);
          font-size: 10.5px;
          margin: -4px 0 12px;
        }
        .welcome-model-progress {
          color: var(--accent);
          font-size: 11px;
        }
        .welcome-progress-bar {
          height: 2px;
          background: var(--hairline);
          margin-top: 8px;
          overflow: hidden;
        }
        .welcome-progress-fill {
          height: 100%;
          background: var(--accent);
          transform-origin: left;
          transition: transform 400ms var(--ease-out);
        }
        .welcome-enter {
          flex: 0 0 auto;
          background: transparent;
          border: none;
          font-family: var(--font-display);
          font-size: 19px;
          color: var(--ink);
          padding: 0;
          transition: color var(--dur-fast) var(--ease-out);
        }
        .welcome-enter:hover {
          color: var(--accent);
        }
      `}</style>
    </div>
  );
}
