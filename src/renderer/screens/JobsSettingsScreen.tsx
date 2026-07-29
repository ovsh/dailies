import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type {
  ModelDownloadProgress, AppSettings, Episode, Job, ProjectFolder } from "../../shared/types";
import { InlineError } from "../components/InlineError";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { runIpc } from "../lib/async";

const STATUS_COLOR: Record<Job["status"], string> = {
  queued: "var(--ink-faint)",
  running: "var(--accent)",
  waiting: "var(--status-warn, var(--ink-faint))",
  done: "var(--status-ok)",
  error: "var(--status-error)",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function formatScanTime(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hh}:${mm}`;
}

function waitingMessage(job: Job): string {
  if (job.stage === "transcribe") return "Waiting for speech model. Download it below.";
  if (job.stage === "embed") {
    return "Waiting for a connected OpenRouter API key. Check it below.";
  }
  return job.error ?? "Waiting for a required setup step.";
}

interface JobsSettingsScreenProps {
  onSettingsChanged?: () => void;
  folders: ProjectFolder[];
  episodes: Episode[];
  onRefresh: () => Promise<unknown>;
}

export function JobsSettingsScreen({ onSettingsChanged, folders, episodes, onRefresh }: JobsSettingsScreenProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [savingProvider, setSavingProvider] = useState<"openrouter" | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelDownloadProgress | null>(null);
  const [newEpisodeCode, setNewEpisodeCode] = useState("");
  const [addingEpisode, setAddingEpisode] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [retryingFileIds, setRetryingFileIds] = useState<Set<number>>(() => new Set());

  const refreshJobs = useCallback(async () => {
    const result = await runIpc(api.listJobs, {
      setPending: setJobsLoading,
      setError: setJobsError,
      fallback: "Could not refresh indexing jobs.",
    });
    if (result.ok) setJobs(result.value);
  }, []);

  const refreshSettings = useCallback(async () => {
    const result = await runIpc(api.getSettings, {
      setPending: setSettingsLoading,
      setError: setSettingsError,
      fallback: "Could not refresh settings.",
    });
    if (result.ok) setSettings(result.value);
  }, []);

  useEffect(() => {
    void refreshJobs();
    void refreshSettings();
  }, [refreshJobs, refreshSettings]);

  useLiveRefresh(refreshJobs);

  useEffect(() => {
    const unsub = api.onModelProgress((p) => {
      setModelProgress(p);
      if (p.done && !p.error) {
        void refreshSettings();
      }
    });
    return unsub;
  }, [refreshSettings]);

  async function handleRemoveFolder(folderId: number, folderPath: string) {
    const confirmed = window.confirm(
      `Remove watched folder "${folderPath}"? Every clip, transcript, and piece of derived media under it will be permanently removed from this project. Your source files will not be touched.`,
    );
    if (!confirmed) return;
    setRetryAction(() => () => void handleRemoveFolder(folderId, folderPath));
    const result = await runIpc(
      async () => {
        await api.removeProjectFolder(folderId);
        await onRefresh();
      },
      { setPending: setActionPending, setError: setActionError, fallback: "Could not remove that folder." },
    );
    if (result.ok) setRetryAction(null);
  }

  async function handleCreateEpisode() {
    const code = newEpisodeCode.trim();
    if (!code) return;
    setRetryAction(() => () => void handleCreateEpisode());
    const result = await runIpc(
      async () => {
        await api.createEpisode(code);
        await onRefresh();
      },
      { setPending: setAddingEpisode, setError: setActionError, fallback: "Could not create that episode." },
    );
    if (result.ok) {
      setNewEpisodeCode("");
      setRetryAction(null);
    }
  }

  async function handleSaveKey(provider: "openrouter") {
    const key = openRouterKey;
    if (!key.trim()) return;
    setRetryAction(() => () => void handleSaveKey(provider));
    const result = await runIpc(
      async () => {
        const status = await api.setApiKey(provider, key.trim());
        if (status === "connected") {
          setSettings(await api.getSettings());
        }
        return status;
      },
      { setPending: (pending) => setSavingProvider(pending ? provider : null), setError: setActionError, fallback: "Could not validate that key." },
    );
    if (!result.ok) return;
    if (result.value === "invalid") {
      setActionError("OpenRouter rejected that API key. Check it and try again.");
      return;
    }
    if (result.value === "unavailable") {
      setActionError("OpenRouter could not be reached to validate the key. Check your connection and retry.");
      return;
    }
    onSettingsChanged?.();
    setOpenRouterKey("");
    setRetryAction(null);
  }

  async function handleDownloadModel() {
    setRetryAction(() => () => void handleDownloadModel());
    setModelProgress({ downloadedMb: 0, totalMb: null, pct: 0, done: false, error: null });
    const result = await runIpc(api.downloadWhisperModel, {
      setPending: setActionPending,
      setError: setActionError,
      fallback: "Could not start the speech model download.",
    });
    if (result.ok) setRetryAction(null);
  }

  async function handleClearProjectCache() {
    const confirmed = window.confirm(
      "Clear every generated proxy, transcript, scene index, and embedding for this project and re-process all watched footage? Your source files will not be touched.",
    );
    if (!confirmed) return;
    setRetryAction(() => () => void handleClearProjectCache());
    const result = await runIpc(
      async () => {
        await api.clearProjectCache();
        await Promise.all([refreshJobs(), onRefresh()]);
      },
      { setPending: setActionPending, setError: setActionError, fallback: "Could not clear the project cache." },
    );
    if (result.ok) setRetryAction(null);
  }

  async function handleRetryFile(fileId: number) {
    setRetryAction(() => () => void handleRetryFile(fileId));
    const result = await runIpc(
      async () => {
        await api.retryFile(fileId);
        await Promise.all([refreshJobs(), onRefresh()]);
      },
      {
        setPending: (pending) => setRetryingFileIds((current) => {
          const next = new Set(current);
          if (pending) next.add(fileId);
          else next.delete(fileId);
          return next;
        }),
        setError: setActionError,
        fallback: "Could not retry failed jobs.",
      },
    );
    if (result.ok) setRetryAction(null);
  }

  const waitingCount = jobs?.filter((job) => job.status === "waiting").length ?? 0;

  return (
    <div className="jobs-screen">
      <div className="jobs-scroll">
        <div className="jobs-column">
          {settingsError && (
            <InlineError message={settingsError} onRetry={() => void refreshSettings()} retrying={settingsLoading} />
          )}
          {actionError && (
            <InlineError
              message={actionError}
              onRetry={retryAction ?? undefined}
              retrying={actionPending || addingEpisode || savingProvider !== null || retryingFileIds.size > 0}
            />
          )}
          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Jobs</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Indexing queue</h2>

              {waitingCount > 0 && (
                <p className="jobs-waiting-summary mono" role="status">
                  {waitingCount} {waitingCount === 1 ? "job is" : "jobs are"} paused until setup is complete. No retry is needed.
                </p>
              )}
              {jobsError && (
                <InlineError message={jobsError} onRetry={() => void refreshJobs()} retrying={jobsLoading} />
              )}

              <table className="jobs-table mono">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Stage</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Details</th>
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
                      <td className={`job-detail${job.status === "waiting" ? " waiting" : job.status === "error" ? " error" : ""}`}>
                        <span>{job.status === "waiting" ? waitingMessage(job) : job.error ?? "—"}</span>
                        {job.status === "error" && (
                          <button
                            type="button"
                            className="job-retry label"
                            onClick={() => void handleRetryFile(job.fileId)}
                            disabled={retryingFileIds.has(job.fileId)}
                          >
                            {retryingFileIds.has(job.fileId) ? "Retrying…" : "Retry failed jobs"}
                          </button>
                        )}
                      </td>
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
              <button className="ghost-btn label" onClick={() => void refreshJobs()} disabled={jobsLoading} style={{ marginTop: 14 }}>
                {jobsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Watched folders</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Watched folders</h2>

              <div className="folder-list">
                {folders.map((folder) => {
                  const episode = folder.episodeId === null ? null : episodes.find((e) => e.id === folder.episodeId);
                  return (
                    <div key={folder.id} className="folder-row">
                      <span className="folder-path-row">
                        <span className="folder-role-tag label">{folder.role === "raw" ? "RAW" : "FINAL"}</span>
                        <span className="mono folder-path">{folder.path}</span>
                        <span className="folder-episode-tag mono">{episode ? episode.code : "ALL"}</span>
                        <span className="folder-scanned mono">
                          {folder.lastScannedAt ? formatScanTime(folder.lastScannedAt) : "never"}
                        </span>
                      </span>
                      <button
                        className="ghost-btn label"
                        onClick={() => void handleRemoveFolder(folder.id, folder.path)}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
                {folders.length === 0 && <p className="jobs-empty mono">No folders watched.</p>}
              </div>
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Episodes</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Episodes</h2>

              <div className="folder-list">
                {episodes.map((ep) => (
                  <div key={ep.id} className="folder-row">
                    <span className="folder-path-row">
                      <span className="mono episode-code">{ep.code}</span>
                      <span className="folder-scanned mono">{formatDate(ep.createdAt)}</span>
                    </span>
                  </div>
                ))}
                {episodes.length === 0 && <p className="jobs-empty mono">No episodes yet.</p>}
              </div>
              <div className="episode-add-row" style={{ marginTop: 14 }}>
                <input
                  className="episode-add-input mono"
                  placeholder="e.g. 204"
                  value={newEpisodeCode}
                  onChange={(e) => setNewEpisodeCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateEpisode()}
                  disabled={addingEpisode}
                />
                <button
                  className="ghost-btn label"
                  onClick={handleCreateEpisode}
                  disabled={!newEpisodeCode.trim() || addingEpisode}
                >
                  {addingEpisode ? "Adding…" : "Add"}
                </button>
              </div>
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">API key</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <ApiKeyField
                label="OpenRouter API key"
                connected={settings?.apiKeyStatus === "connected"}
                value={openRouterKey}
                onChange={setOpenRouterKey}
                onSave={() => handleSaveKey("openrouter")}
                saving={savingProvider === "openrouter"}
              />
              <p className="jobs-hint mono">
                Need a key?{" "}
                <button
                  className="text-link"
                  onClick={() => void api.openExternal("https://openrouter.ai/keys")}
                >
                  Create one at openrouter.ai/keys
                </button>
                . Free to sign up, then paste it here.
              </p>
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Transcription</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <div className="trans-row">
                <span className="trans-name">Whisper engine</span>
                <span className={`trans-status mono${settings?.whisperAvailable ? " ok" : ""}`}>
                  {settings?.whisperAvailable ? "built in" : "missing"}
                </span>
              </div>
              <div className="trans-row">
                <span className="trans-name">
                  Speech model
                  <span className="trans-sub mono"> {settings?.whisperModel ?? ""} · ~1.6 GB · one-time download</span>
                </span>
                {settings?.whisperModelReady ? (
                  <span className="trans-status mono ok">downloaded</span>
                ) : modelProgress && !modelProgress.done ? (
                  <span className="trans-status mono">
                    {modelProgress.pct !== null ? `${modelProgress.pct}%` : `${Math.round(modelProgress.downloadedMb)} MB`}
                  </span>
                ) : (
                  <button
                    className="ghost-btn label"
                    onClick={() => void handleDownloadModel()}
                    disabled={actionPending}
                  >
                    Download
                  </button>
                )}
              </div>
              {modelProgress && !modelProgress.done && modelProgress.pct !== null && (
                <div className="trans-bar">
                  <div className="trans-bar-fill" style={{ transform: `scaleX(${modelProgress.pct / 100})` }} />
                </div>
              )}
              {modelProgress?.error && <p className="jobs-error mono">{modelProgress.error}</p>}
              <p className="jobs-hint mono">
                Everything transcribes on this Mac. Audio never leaves the machine.
              </p>
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Danger zone</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Clear cache &amp; reprocess</h2>
              <p className="jobs-hint mono" style={{ marginTop: 0 }}>
                Deletes every generated proxy, transcript, scene index, and embedding for this project and re-processes all watched footage from scratch. Your source files are never touched.
              </p>
              <button
                className="ghost-btn label"
                onClick={() => void handleClearProjectCache()}
                disabled={actionPending}
              >
                {actionPending ? "Clearing…" : "Clear cache & reprocess"}
              </button>
            </div>
          </section>
        </div>
      </div>

      <style>{`
        .jobs-screen {
          height: 100%;
          overflow: hidden;
          background: var(--ground);
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
        .jobs-scroll {
          height: 100%;
          overflow-y: auto;
          padding: 40px 40px 80px;
        }
        .jobs-column {
          max-width: 800px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        .jobs-section {
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--bevel-out), var(--shadow-card);
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .panel-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 7px 10px;
          box-shadow: inset 0 -1px 0 var(--chrome-lo);
          user-select: none;
        }
        .panel-bar-close {
          width: 11px;
          height: 11px;
          flex: none;
          background: var(--ground-raised);
          box-shadow: var(--bevel-out);
          border: 1px solid var(--chrome-lo);
        }
        .panel-bar-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--ink);
          white-space: nowrap;
        }
        .panel-bar-stripes {
          flex: 1;
          height: 8px;
          background: repeating-linear-gradient(0deg, var(--chrome-lo) 0 1px, transparent 1px 3px);
          opacity: 0.5;
        }
        .panel-body {
          background: var(--ground-card);
          border: 1px solid var(--chrome-lo);
          margin: 8px;
          padding: 22px 24px 26px;
        }
        .panel-title {
          font-size: 19px;
          color: var(--ink);
          margin: 0 0 18px;
        }
        .jobs-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11.5px;
        }
        .jobs-table th {
          text-align: left;
          background: var(--ground-raised);
          color: var(--ink-dim);
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          font-size: 9.5px;
          padding: 8px 12px 8px 10px;
          border-bottom: 1px solid var(--chrome-lo);
        }
        .jobs-table th:first-child {
          padding-left: 10px;
        }
        .jobs-table td {
          padding: 9px 12px 9px 10px;
          border-bottom: 1px solid var(--paper-alt);
          color: var(--ink-dim);
          vertical-align: top;
        }
        .jobs-table tbody tr:nth-child(even) td {
          background: var(--paper-alt);
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
        .jobs-waiting-summary {
          color: var(--status-warn);
          background: rgba(138, 109, 22, 0.08);
          border: 1px solid rgba(138, 109, 22, 0.25);
          border-radius: 2px;
          font-size: 11px;
          padding: 9px 11px;
          margin: 0 0 16px;
        }
        .job-detail {
          max-width: 290px;
        }
        .job-retry {
          display: block;
          margin-top: 6px;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-out);
          color: var(--ink-dim);
          padding: 3px 8px;
          border-radius: 2px;
          font-size: 9px;
        }
        .job-retry:hover:not(:disabled) {
          background: #d2d6d9;
          color: var(--accent);
        }
        .job-retry:active:not(:disabled) {
          box-shadow: var(--bevel-in);
        }
        .job-retry:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
        .job-detail.error {
          color: var(--status-error);
        }
        .job-detail.waiting {
          color: var(--status-warn);
        }
        .jobs-empty {
          color: var(--ink-faint);
          padding: 16px 0;
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
        .folder-episode-tag {
          font-size: 10.5px;
          color: var(--ink-dimmer);
        }
        .folder-scanned {
          font-size: 10.5px;
          color: var(--ink-faint);
        }
        .episode-code {
          font-size: 13px;
          color: var(--ink);
        }
        .episode-add-row {
          display: flex;
          gap: 10px;
        }
        .episode-add-input {
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          padding: 9px 12px;
          color: var(--ink);
          font-size: 12.5px;
          width: 140px;
        }
        .episode-add-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .episode-add-input::placeholder {
          color: var(--ink-faint);
        }
        .trans-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 14px 0;
          border-bottom: 1px solid var(--hairline);
        }
        .trans-name {
          font-size: 13px;
          color: var(--ink-dim);
        }
        .trans-sub {
          font-size: 10.5px;
          color: var(--ink-faint);
          margin-left: 8px;
        }
        .trans-status {
          font-size: 11px;
          color: var(--ink-dimmer);
        }
        .trans-status.ok {
          color: var(--status-ok);
        }
        .trans-bar {
          height: 4px;
          background: var(--paper-alt);
          box-shadow: var(--bevel-in);
          margin: 12px 0 4px;
          overflow: hidden;
        }
        .trans-bar-fill {
          height: 100%;
          background: var(--accent);
          transform-origin: left;
          transition: transform 400ms var(--ease-out);
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
          placeholder={connected ? "•••••••••••••••••••• (replace)" : "sk-or-v1-…"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="ghost-btn label" onClick={onSave} disabled={!value.trim() || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <style>{`
        .api-key-field {
          padding-bottom: 4px;
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
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          padding: 9px 12px;
          color: var(--ink);
          font-size: 12.5px;
        }
        .api-key-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
      `}</style>
    </div>
  );
}
