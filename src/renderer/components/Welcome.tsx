import { useState } from "react";
import { api } from "../api";
import type { AppSettings } from "../../shared/types";

interface WelcomeProps {
  settings: AppSettings;
  onSettingsChanged: () => void;
  onDismiss: () => void;
}

/**
 * First-run setup. Shown when no API key is set and no folder is watched —
 * the two things Dailies cannot work without.
 */
export function Welcome({ settings, onSettingsChanged, onDismiss }: WelcomeProps) {
  const [geminiKey, setGeminiKey] = useState("");
  const [saving, setSaving] = useState<"gemini" | null>(null);

  const configured = settings.geminiKeySet || settings.watchedFolders.length > 0;

  async function saveKey(provider: "gemini", key: string) {
    if (!key.trim()) return;
    setSaving(provider);
    await api.setApiKey(provider, key.trim());
    setSaving(null);
    setGeminiKey("");
    onSettingsChanged();
  }

  async function chooseFolder() {
    const folder = await api.addWatchedFolder();
    if (folder) onSettingsChanged();
  }

  return (
    <div className="welcome-overlay">
      <div className="welcome-panel">
        <p className="welcome-mark display">Dailies</p>
        <p className="welcome-sub">
          Chat with your footage. Two things to set up — everything stays on this Mac.
        </p>

        <div className="welcome-step">
          <div className="welcome-step-head">
            <span className="welcome-step-num mono">01</span>
            <span className="label">Gemini API key</span>
            {settings.geminiKeySet && <span className="welcome-check">connected</span>}
          </div>
          <p className="welcome-step-why">
            Powers everything — the chat agents that search your footage, and the visual index
            that reads what's on screen.
          </p>
          {!settings.geminiKeySet && (
            <div className="welcome-row">
              <input
                type="password"
                className="welcome-input mono"
                placeholder="AIza…"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveKey("gemini", geminiKey)}
              />
              <button
                className="ghost-btn label"
                onClick={() => saveKey("gemini", geminiKey)}
                disabled={!geminiKey.trim() || saving === "gemini"}
              >
                {saving === "gemini" ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>

        <div className="welcome-step">
          <div className="welcome-step-head">
            <span className="welcome-step-num mono">02</span>
            <span className="label">Footage folder</span>
            {settings.watchedFolders.length > 0 && <span className="welcome-check">watching</span>}
          </div>
          <p className="welcome-step-why">
            Point Dailies at a folder. Files are indexed in place — nothing is moved or copied — and
            new footage dropped in later is picked up automatically.
          </p>
          {settings.watchedFolders.map((f) => (
            <p key={f} className="welcome-folder mono">{f}</p>
          ))}
          <button className="ghost-btn label" onClick={chooseFolder}>
            {settings.watchedFolders.length > 0 ? "Add another folder…" : "Choose a folder…"}
          </button>
        </div>

        <div className="welcome-footer">
          <button className="welcome-enter" onClick={onDismiss}>
            {configured ? "Enter Dailies →" : "Skip for now →"}
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
          align-items: center;
          justify-content: center;
          overflow-y: auto;
          animation: fade-in var(--dur-med) var(--ease-out) both;
        }
        .welcome-panel {
          width: 480px;
          max-width: calc(100vw - 96px);
          padding: 48px 0;
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .welcome-mark {
          font-size: 44px;
          color: var(--ink);
          margin: 0 0 10px;
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
          font-size: 11.5px;
          color: var(--ink-dim);
          margin: 0 0 10px;
        }
        .welcome-footer {
          border-top: 1px solid var(--hairline);
          padding-top: 28px;
          display: flex;
          justify-content: flex-end;
        }
        .welcome-enter {
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
