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
        <div className="welcome-bar">
          <span className="welcome-bar-close" aria-hidden="true" />
          <span className="welcome-bar-title">Setup</span>
          <span className="welcome-bar-stripes" aria-hidden="true" />
        </div>
        <div className="welcome-body">
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
          padding: 26px 28px 30px;
        }
        .welcome-mark {
          font-size: 40px;
          color: var(--ink);
          margin: 0 0 10px;
          letter-spacing: -0.015em;
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
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          color: var(--ink);
          font-size: 12.5px;
          padding: 8px 10px;
        }
        .welcome-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
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
        .welcome-enter {
          flex: 0 0 auto;
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          border-radius: 999px;
          font-family: var(--font-body);
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #fff;
          padding: 12px 22px;
          box-shadow: inset 1px 2px 0 rgba(255,255,255,.28), inset -1px -2px 0 rgba(0,0,0,.22), 2px 3px 0 rgba(23,25,27,.3);
        }
        .welcome-enter:hover {
          transform: translate(1px, 1px);
          box-shadow: inset 1px 2px 0 rgba(255,255,255,.28), inset -1px -2px 0 rgba(0,0,0,.22), 1px 1px 0 rgba(23,25,27,.3);
        }
      `}</style>
    </div>
  );
}
