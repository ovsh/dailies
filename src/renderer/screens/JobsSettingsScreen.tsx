import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, Job, MediaRole, QualityMode } from "../../shared/types";

const STATUS_COLOR: Record<Job["status"], string> = {
  queued: "var(--ink-faint)",
  running: "var(--accent)",
  done: "var(--status-ok)",
  error: "var(--status-error)",
};

interface JobsSettingsScreenProps {
  onSettingsChanged?: () => void;
}

export function JobsSettingsScreen({ onSettingsChanged }: JobsSettingsScreenProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [geminiKey, setGeminiKey] = useState("");
  const [savingProvider, setSavingProvider] = useState<"gemini" | null>(null);

  useEffect(() => {
    api.listJobs().then(setJobs);
    api.getSettings().then(setSettings);
  }, []);

  async function refreshJobs() {
    setJobs(await api.listJobs());
  }

  async function handleAddFolder(role: MediaRole) {
    const path = await api.addWatchedFolder(role);
    if (path) {
      setSettings(await api.getSettings());
      onSettingsChanged?.();
    }
  }

  async function handleRemoveFolder(path: string) {
    await api.removeWatchedFolder(path);
    setSettings(await api.getSettings());
    onSettingsChanged?.();
  }

  async function handleSaveKey(provider: "gemini") {
    const key = geminiKey;
    if (!key.trim()) return;
    setSavingProvider(provider);
    await api.setApiKey(provider, key.trim());
    setSettings(await api.getSettings());
    onSettingsChanged?.();
    setGeminiKey("");
    setSavingProvider(null);
  }

  async function handleQualityChange(mode: QualityMode) {
    await api.setQualityMode(mode);
    setSettings(await api.getSettings());
  }

  return (
    <div className="jobs-screen">
      <div className="jobs-scroll">
        <div className="jobs-column">
          <section className="jobs-section">
            <div className="section-head">
              <span className="label">Jobs</span>
              <h2 className="display">Indexing queue</h2>
            </div>

            <table className="jobs-table mono">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs?.map((job) => (
                  <tr key={job.id}>
                    <td className="jobs-filename" title={job.filename}>
                      {job.filename}
                    </td>
                    <td>{job.stage}</td>
                    <td>
                      <span className="job-status">
                        <span className="job-status-dot" style={{ background: STATUS_COLOR[job.status] }} />
                        {job.status}
                      </span>
                    </td>
                    <td>{job.attempts}</td>
                    <td className="jobs-error">{job.error ?? "—"}</td>
                  </tr>
                ))}
                {jobs?.length === 0 && (
                  <tr>
                    <td colSpan={5} className="jobs-empty">
                      Queue is empty.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <button className="ghost-btn label" onClick={refreshJobs} style={{ marginTop: 14 }}>
              Refresh
            </button>
          </section>

          <section className="jobs-section">
            <div className="section-head">
              <span className="label">Settings</span>
              <h2 className="display">Watched folders</h2>
            </div>

            <div className="folder-list">
              {settings?.watchedFolders.map((folder) => (
                <div key={folder.path} className="folder-row">
                  <span className="folder-path-row">
                    <span className="folder-role-tag label">{folder.role === "raw" ? "RAW" : "FINAL"}</span>
                    <span className="mono folder-path">{folder.path}</span>
                  </span>
                  <button className="ghost-btn label" onClick={() => handleRemoveFolder(folder.path)}>
                    Remove
                  </button>
                </div>
              ))}
              {settings && settings.watchedFolders.length === 0 && (
                <p className="jobs-empty mono">No folders watched.</p>
              )}
            </div>
            <div className="folder-add-btns" style={{ marginTop: 14 }}>
              <button className="ghost-btn label" onClick={() => handleAddFolder("raw")}>
                + Add raw folder
              </button>
              <button className="ghost-btn label" onClick={() => handleAddFolder("final")}>
                + Add finals folder
              </button>
            </div>
          </section>

          <section className="jobs-section">
            <div className="section-head">
              <span className="label">API key</span>
            </div>

            <ApiKeyField
              label="Gemini API key"
              connected={settings?.geminiKeySet ?? false}
              value={geminiKey}
              onChange={setGeminiKey}
              onSave={() => handleSaveKey("gemini")}
              saving={savingProvider === "gemini"}
            />
          </section>

          <section className="jobs-section">
            <div className="section-head">
              <span className="label">Quality</span>
            </div>
            <div className="quality-toggle">
              {(["standard", "high"] as QualityMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`quality-btn label${settings?.qualityMode === mode ? " active" : ""}`}
                  onClick={() => handleQualityChange(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
            <p className="jobs-hint mono">
              whisper: {settings?.whisperModel ?? "—"} · {settings?.whisperAvailable ? "available" : "unavailable"} · ffmpeg:{" "}
              {settings?.ffmpegAvailable ? "available" : "unavailable"}
            </p>
          </section>
        </div>
      </div>

      <style>{`
        .jobs-screen {
          height: 100%;
          overflow: hidden;
        }
        .jobs-scroll {
          height: 100%;
          overflow-y: auto;
          padding: 56px 48px 80px;
        }
        .jobs-column {
          max-width: 780px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 56px;
        }
        .jobs-section {
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .api-key-label {
          display: block;
          margin-bottom: 8px;
        }
        .section-head {
          margin-bottom: 22px;
        }
        .section-head h2 {
          font-size: 22px;
          color: var(--ink);
          margin: 6px 0 0;
        }
        .jobs-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11.5px;
        }
        .jobs-table th {
          text-align: left;
          color: var(--ink-faint);
          font-weight: 500;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-size: 9.5px;
          padding: 0 12px 10px 0;
          border-bottom: 1px solid var(--hairline);
        }
        .jobs-table td {
          padding: 10px 12px 10px 0;
          border-bottom: 1px solid var(--hairline);
          color: var(--ink-dim);
          vertical-align: top;
        }
        .jobs-filename {
          color: var(--ink);
          max-width: 260px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .job-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .job-status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex: 0 0 auto;
        }
        .jobs-error {
          color: var(--status-error);
          max-width: 280px;
        }
        .jobs-empty {
          color: var(--ink-faint);
          padding: 16px 0;
        }
        .ghost-btn {
          background: transparent;
          border: 1px solid var(--hairline-strong);
          color: var(--ink-dim);
          padding: 7px 14px;
          border-radius: 6px;
          transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
        }
        .ghost-btn:hover {
          border-color: var(--accent-dim);
          color: var(--accent);
        }
        .folder-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .folder-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 11px 0;
          border-bottom: 1px solid var(--hairline);
        }
        .folder-path-row {
          display: flex;
          align-items: baseline;
          gap: 10px;
        }
        .folder-role-tag {
          color: var(--ink-dimmer);
          font-size: 9.5px;
        }
        .folder-path {
          font-size: 12px;
          color: var(--ink-dim);
        }
        .folder-add-btns {
          display: flex;
          gap: 10px;
        }
        .quality-toggle {
          display: inline-flex;
          border: 1px solid var(--hairline-strong);
          border-radius: 7px;
          overflow: hidden;
        }
        .quality-btn {
          background: transparent;
          border: none;
          color: var(--ink-dimmer);
          padding: 9px 20px;
        }
        .quality-btn + .quality-btn {
          border-left: 1px solid var(--hairline-strong);
        }
        .quality-btn.active {
          background: var(--accent-wash);
          color: var(--accent);
        }
        .jobs-hint {
          margin-top: 14px;
          font-size: 11px;
          color: var(--ink-faint);
        }
      `}</style>
    </div>
  );
}

interface ApiKeyFieldProps {
  label: string;
  connected: boolean;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}

function ApiKeyField({ label, connected, value, onChange, onSave, saving }: ApiKeyFieldProps) {
  return (
    <div className="api-key-field">
      <div className="api-key-head">
        <span className="api-key-label label">{label}</span>
        {connected && (
          <span className="api-key-connected">
            <span className="api-key-dot" />
            connected
          </span>
        )}
      </div>
      <div className="api-key-row">
        <input
          type="password"
          className="api-key-input mono"
          placeholder={connected ? "•••••••••••••••••••• (replace)" : "AIza…"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="ghost-btn label" onClick={onSave} disabled={!value.trim() || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <style>{`
        .api-key-field {
          padding: 16px 0;
          border-bottom: 1px solid var(--hairline);
        }
        .api-key-head {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        .api-key-connected {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 10.5px;
          color: var(--status-ok);
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .api-key-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--status-ok);
        }
        .api-key-row {
          display: flex;
          gap: 10px;
        }
        .api-key-input {
          flex: 1;
          background: var(--ground-raised);
          border: 1px solid var(--hairline);
          border-radius: 6px;
          padding: 9px 12px;
          color: var(--ink);
          font-size: 12.5px;
        }
        .api-key-input:focus-visible {
          border-color: var(--accent-dim);
        }
      `}</style>
    </div>
  );
}
