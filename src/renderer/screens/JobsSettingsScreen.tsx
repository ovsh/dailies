import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { chatModelOption, EMBEDDING_MODEL } from "../../shared/types";
import type {
  ClipListInput,
  EpisodeMembershipReport,
  EpisodeMembershipResolution,
  EpisodeProposal,
  MembershipSource,
  ModelDownloadProgress,
  AppSettings,
  Episode,
  Job,
  PipelineProgress,
  PipelineSnapshot,
  ProjectFolder,
  UpdaterState,
} from "../../shared/types";
import type { ClipListImportBlocked, ClipListImportDiagnostic } from "../../shared/ipc";
import { EpisodeProposalCard } from "../components/EpisodeProposalCard";
import { InlineError } from "../components/InlineError";
import { Toast } from "../components/Toast";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { runIpc } from "../lib/async";

/** First line only — the rest (full ffmpeg stderr, etc.) stays behind the expand affordance. */
function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim();
  return line && line.length > 0 ? line : text.trim();
}

function hasMoreLines(text: string): boolean {
  return text.trim().includes("\n");
}

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

function formatCheckedAt(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${day} ${month}, ${time}`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function waitingMessage(job: Job): string {
  if (job.stage === "transcribe") return "Waiting for speech model. Download it below.";
  if (job.stage === "embed") {
    return "Waiting for a connected OpenRouter API key. Check it below.";
  }
  return job.error ?? "Waiting for a required setup step.";
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_DAY_S = 24 * 60 * 60;

// Five-minute marks keep an estimate from implying second-level precision.
function etaTarget(seconds: number, from: Date): Date {
  return new Date(Math.round((from.getTime() + seconds * 1000) / FIVE_MIN_MS) * FIVE_MIN_MS);
}

function clockTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function clipCount(count: number): string {
  return `${count} ${count === 1 ? "clip" : "clips"}`;
}

function formatEtaClock(seconds: number | null, from: Date): string | null {
  if (seconds === null) return null;
  const target = etaTarget(seconds, from);
  if (seconds < ONE_DAY_S) return clockTime(target);
  return target.toLocaleDateString("en-US", { weekday: "long" });
}

function formatEtaDayTime(seconds: number | null, from: Date): string | null {
  if (seconds === null) return null;
  const target = etaTarget(seconds, from);
  if (seconds < ONE_DAY_S) return clockTime(target);
  const weekday = target.toLocaleDateString("en-US", { weekday: "long" });
  return `${weekday} ${target.toLocaleTimeString("en-US", { hour: "numeric" })}`;
}

function progressEqual(a: PipelineProgress, b: PipelineProgress): boolean {
  return a.phase === b.phase &&
    a.totalFiles === b.totalFiles &&
    a.searchableFiles === b.searchableFiles &&
    a.searchRemaining === b.searchRemaining &&
    a.searchableEtaSeconds === b.searchableEtaSeconds &&
    a.playbackDone === b.playbackDone &&
    a.playbackRemaining === b.playbackRemaining &&
    a.playbackEtaSeconds === b.playbackEtaSeconds &&
    a.cantFindCount === b.cantFindCount &&
    a.cantPlayCount === b.cantPlayCount &&
    a.failedCount === b.failedCount &&
    formatEtaClock(a.searchableEtaSeconds, new Date(a.updatedAt)) ===
      formatEtaClock(b.searchableEtaSeconds, new Date(b.updatedAt)) &&
    formatEtaDayTime(a.playbackEtaSeconds, new Date(a.updatedAt)) ===
      formatEtaDayTime(b.playbackEtaSeconds, new Date(b.updatedAt));
}

const MEMBERSHIP_SOURCE_LABEL: Record<MembershipSource, string> = {
  folder: "Folders",
  list: "Clip list",
  "media-tag": "Media tags",
};

function isBlockedImport(
  result: EpisodeMembershipReport | ClipListImportBlocked,
): result is ClipListImportBlocked {
  return "kind" in result && result.kind === "blocked";
}

function countNonBlankLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
}

const RESOLUTION_LABEL: Record<EpisodeMembershipResolution["kind"], string> = {
  matched: "Matched",
  ambiguous: "Ambiguous",
  unmatched: "Not found",
};

const RESOLUTION_COLOR: Record<EpisodeMembershipResolution["kind"], string> = {
  matched: "var(--status-ok)",
  ambiguous: "var(--status-warn)",
  unmatched: "var(--status-error)",
};

interface JobsSettingsScreenProps {
  onSettingsChanged?: () => void;
  folders: ProjectFolder[];
  episodes: Episode[];
  onRefresh: () => Promise<unknown>;
  updateState: UpdaterState;
  /** "On next quit" dismisses, same as "Later" on the banner. */
  onDismissUpdate: () => void;
}

export function JobsSettingsScreen({
  onSettingsChanged,
  folders,
  episodes,
  onRefresh,
  updateState,
  onDismissUpdate,
}: JobsSettingsScreenProps) {
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
  const [snapshot, setSnapshot] = useState<PipelineSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [progressLoading, setProgressLoading] = useState(true);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [failuresExpanded, setFailuresExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [selectedFailureIds, setSelectedFailureIds] = useState<Set<number>>(() => new Set());
  const [bulkRetryPending, setBulkRetryPending] = useState(false);
  const [csvExportPending, setCsvExportPending] = useState(false);
  const [expandedFailureIds, setExpandedFailureIds] = useState<Set<number>>(() => new Set());
  const [expandedJobIds, setExpandedJobIds] = useState<Set<number>>(() => new Set());
  const [telemetryPending, setTelemetryPending] = useState(false);
  const [diagnosticsPending, setDiagnosticsPending] = useState(false);
  const [toast, setToast] = useState<{ message: string; actionLabel?: string; onAction?: () => void } | null>(null);
  const [episodeReports, setEpisodeReports] = useState<Record<number, EpisodeMembershipReport>>({});
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<number | null>(null);
  const [proposal, setProposal] = useState<EpisodeProposal | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectNotice, setDetectNotice] = useState<string | null>(null);

  const syncedFailedCount = useRef<number | null>(null);

  const refreshJobs = useCallback(async () => {
    const result = await runIpc(api.listJobs, {
      setPending: setJobsLoading,
      setError: setJobsError,
      fallback: "Could not refresh indexing jobs.",
    });
    if (result.ok) setJobs(result.value);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const result = await runIpc(() => api.getPipelineSnapshot({ episodeId: null }), {
      setPending: setSnapshotLoading,
      setError: setSnapshotError,
      fallback: "Could not load the list of clips with problems.",
    });
    if (result.ok) {
      setSnapshot(result.value);
      syncedFailedCount.current = result.value.failures.length;
      setSelectedFailureIds((current) => {
        const validIds = new Set(result.value.failures.map((f) => f.fileId));
        const next = new Set([...current].filter((id) => validIds.has(id)));
        return next.size === current.size ? current : next;
      });
      return result.value;
    }
    return null;
  }, []);

  const refreshProgress = useCallback(async () => {
    const result = await runIpc(() => api.getPipelineProgress({ episodeId: null }), {
      setPending: setProgressLoading,
      setError: setProgressError,
      fallback: "Could not check on your footage.",
    });
    if (result.ok) {
      setProgress((prev) => (prev !== null && progressEqual(prev, result.value) ? prev : result.value));
    }
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
    void refreshSnapshot();
    void refreshProgress();
  }, [refreshJobs, refreshProgress, refreshSettings, refreshSnapshot]);

  useLiveRefresh(refreshJobs);
  useLiveRefresh(refreshProgress);

  useEffect(() => {
    const failedCount = progress?.failedCount;
    if (
      failedCount === undefined ||
      syncedFailedCount.current === null ||
      failedCount === syncedFailedCount.current
    ) {
      return;
    }
    void refreshSnapshot();
  }, [progress?.failedCount, refreshSnapshot]);

  useEffect(() => {
    const unsub = api.onModelProgress((p) => {
      setModelProgress(p);
      if (p.done && !p.error) {
        void refreshSettings();
      }
    });
    return unsub;
  }, [refreshSettings]);

  const refreshEpisodeReports = useCallback(async () => {
    const entries = await Promise.all(
      episodes.map(async (ep) => {
        try {
          return [ep.id, await api.getEpisodeMembership(ep.id)] as const;
        } catch {
          return null;
        }
      }),
    );
    setEpisodeReports((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      return next;
    });
  }, [episodes]);

  useEffect(() => {
    void refreshEpisodeReports();
  }, [refreshEpisodeReports]);

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

  /**
   * Reads the Avid project tag out of any clip that never had one, then shows
   * what the tags say. Tag reads run in the background, so a proposal can come
   * back with rows still pending; the card offers a second look.
   */
  async function handleDetectEpisodes() {
    setRetryAction(() => () => void handleDetectEpisodes());
    const result = await runIpc(
      () => api.detectEpisodesFromMedia(),
      { setPending: setDetecting, setError: setActionError, fallback: "Could not read project tags from the media." },
    );
    if (!result.ok) return;
    setRetryAction(null);
    setProposal(result.value.rows.length > 0 ? result.value : null);
    if (result.value.rows.length > 0) {
      setDetectNotice(null);
    } else if (result.value.pendingClipCount > 0) {
      setDetectNotice(`Reading project tags on ${clipCount(result.value.pendingClipCount)}. Try again in a moment.`);
    } else {
      setDetectNotice("No Avid project tags were found in this media.");
    }
  }

  async function handleApplyProposal(rows: Array<{ code: string; sourceProject: string }>) {
    await api.applyEpisodeProposal(rows);
    setProposal(null);
    setDetectNotice(null);
    await onRefresh();
    await refreshEpisodeReports();
  }

  async function handleSetMembershipSource(episodeId: number, source: MembershipSource) {
    const report = await api.setEpisodeMembershipSource(episodeId, source);
    setEpisodeReports((prev) => ({ ...prev, [episodeId]: report }));
    await onRefresh();
  }

  async function handleImportClipList(
    episodeId: number,
    input: ClipListInput,
  ): Promise<EpisodeMembershipReport | ClipListImportBlocked> {
    const result = await api.replaceEpisodeClipList(episodeId, input);
    if (!isBlockedImport(result)) {
      setEpisodeReports((prev) => ({ ...prev, [episodeId]: result }));
      await onRefresh();
    }
    return result;
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
        await Promise.all([refreshJobs(), refreshProgress(), refreshSnapshot(), onRefresh()]);
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

  function toggleFailureSelected(fileId: number) {
    setSelectedFailureIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function toggleAllFailuresSelected() {
    const failures = snapshot?.failures ?? [];
    setSelectedFailureIds((current) =>
      current.size === failures.length ? new Set() : new Set(failures.map((f) => f.fileId)),
    );
  }

  async function handleBulkRetry(fileIds = [...selectedFailureIds]) {
    if (fileIds.length === 0) return;
    setRetryAction(() => () => void handleBulkRetry(fileIds));
    const result = await runIpc(
      async () => {
        const nextSnapshot = await api.retryPipelineFailures(fileIds);
        setSnapshot(nextSnapshot);
        syncedFailedCount.current = nextSnapshot.failures.length;
        await Promise.all([refreshJobs(), refreshProgress(), onRefresh()]);
      },
      { setPending: setBulkRetryPending, setError: setActionError, fallback: "Could not retry the selected files." },
    );
    if (result.ok) {
      setSelectedFailureIds(new Set());
      setRetryAction(null);
    }
  }

  async function handleRetryAllFailures() {
    const latestSnapshot = await refreshSnapshot();
    if (latestSnapshot === null) return;
    await handleBulkRetry(latestSnapshot.failures.map((failure) => failure.fileId));
  }

  async function handleExportFailuresCsv() {
    const result = await runIpc(() => api.exportPipelineFailures({ episodeId: null }), {
      setPending: setCsvExportPending,
      setError: setActionError,
      fallback: "Could not export failures.",
    });
    if (!result.ok) return;
    await refreshSnapshot();
    if (result.value.kind === "blocked") {
      setActionError("There are no failures to export.");
      return;
    }
    await api.revealInFinder(result.value.path);
  }

  function toggleFailuresExpanded() {
    if (!failuresExpanded) void refreshSnapshot();
    setFailuresExpanded((current) => !current);
  }

  function toggleFailureExpanded(fileId: number) {
    setExpandedFailureIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function toggleJobExpanded(jobId: number) {
    setExpandedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  async function handleSetTelemetry(enabled: boolean) {
    const result = await runIpc(() => api.setTelemetryEnabled(enabled), {
      setPending: setTelemetryPending,
      setError: setActionError,
      fallback: "Could not change the usage data setting.",
    });
    if (result.ok) setSettings(result.value);
  }

  async function handleExportDiagnostics() {
    const result = await runIpc(() => api.exportDiagnostics(), {
      setPending: setDiagnosticsPending,
      setError: setActionError,
      fallback: "Could not export diagnostics.",
    });
    if (!result.ok) return;
    if (result.value.kind === "blocked") {
      setActionError(result.value.reason);
      return;
    }
    const path = result.value.path;
    setToast({
      message: `Diagnostics written to ${path}`,
      actionLabel: "Show in folder",
      onAction: () => void api.revealInFinder(path),
    });
  }

  const waitingCount = jobs?.filter((job) => job.status === "waiting").length ?? 0;

  function renderProblemsRow(failedCount: number) {
    if (failedCount === 0) return null;
    return (
      <div className="footage-problems-row">
        <span className="footage-problems-count mono">
          {clipCount(failedCount)} {failedCount === 1 ? "has" : "have"} problems
        </span>
        <button type="button" className="ghost-btn label" onClick={toggleFailuresExpanded}>
          {failuresExpanded ? "Hide them" : "See them"}
        </button>
      </div>
    );
  }

  function renderPipelineProgress(current: PipelineProgress) {
    const phase = current.phase;
    const now = new Date(current.updatedAt);
    const playbackEta = formatEtaDayTime(current.playbackEtaSeconds, now) ??
      "Working out how long this will take";
    const searchTotal = current.searchableFiles + current.searchRemaining;
    const searchPercent = searchTotal === 0
      ? 0
      : Math.round((current.searchableFiles / searchTotal) * 100);

    switch (phase) {
      case "starting":
        return (
          <div className="footage-state footage-state-starting" role="status">
            <h3 className="footage-lede">Reading your files</h3>
            <p className="footage-sub">You get a time estimate in a few minutes. You can leave this running.</p>
            <div className="footage-progress" role="progressbar" aria-label="Reading files">
              <span className="footage-progress-fill footage-progress-fill-starting" />
            </div>
            <p className="footage-count mono">{clipCount(current.totalFiles)} found</p>
          </div>
        );
      case "working": {
        const readyAt = formatEtaClock(current.searchableEtaSeconds, now);
        return (
          <div className="footage-state footage-state-working" role="status">
            <h3 className="footage-lede">
              {readyAt === null ? (
                "Working out how long this will take"
              ) : (
                <>Ready at <span className="mono">{readyAt}</span></>
              )}
            </h3>
            <p className="footage-sub">Then you can ask for any moment in your footage.</p>
            <div
              className="footage-progress"
              role="progressbar"
              aria-label="Clips ready to search"
              aria-valuemin={0}
              aria-valuemax={searchTotal}
              aria-valuenow={current.searchableFiles}
            >
              <span className="footage-progress-fill" style={{ width: `${searchPercent}%` }} />
            </div>
            <p className="footage-count mono">
              {current.searchableFiles} of {searchTotal} clips done
            </p>
            <div className="footage-secondary">
              <span>Video playback comes later</span>
              <span className="footage-secondary-eta mono">{playbackEta}</span>
            </div>
            {renderProblemsRow(current.failedCount)}
          </div>
        );
      }
      case "ready":
        return (
          <div className="footage-state footage-state-ready" role="status">
            <h3 className="footage-lede footage-lede-ready">
              <span className="footage-ready-mark" aria-hidden="true">✓</span>
              Your footage is ready
            </h3>
            <p className="footage-sub">Ask for any moment — like "where do they talk about the beach house?"</p>
            <div
              className="footage-progress"
              role="progressbar"
              aria-label="Clips ready to search"
              aria-valuetext={`${current.searchableFiles} clips ready`}
            >
              <span className="footage-progress-fill footage-progress-fill-ready" />
            </div>
            <p className="footage-count mono">{clipCount(current.searchableFiles)} ready</p>
            <div className="footage-secondary">
              <span>Video playback comes later. You can work now.</span>
              <span className="footage-secondary-eta mono">{playbackEta}</span>
            </div>
            {renderProblemsRow(current.failedCount)}
          </div>
        );
      case "done":
        return (
          <div className="footage-state footage-state-done" role="status">
            <h3 className="footage-lede">All done</h3>
            {current.failedCount > 0 && (
              <p className="footage-sub">
                {clipCount(current.failedCount)} {current.failedCount === 1 ? "needs" : "need"} a look.
              </p>
            )}
            <div className="footage-metrics">
              <div className="footage-metric">
                <span className="footage-metric-label">READY TO USE</span>
                <span className="footage-metric-value mono">{current.searchableFiles}</span>
              </div>
              <div className="footage-metric">
                <span className="footage-metric-label">PLAY IN APP</span>
                <span className="footage-metric-value mono">{current.playbackDone}</span>
              </div>
            </div>
            {current.failedCount > 0 && (
              <div className="footage-needs-look">
                <h4 className="footage-needs-title">Needs a look</h4>
                <div className="footage-issue">
                  <p className="footage-issue-title footage-issue-warn">
                    <span className="mono">{clipCount(current.cantPlayCount)}</span> will not play in the app
                  </p>
                  <p className="footage-issue-note">You can still find them. Open them in your editor.</p>
                </div>
                <div className="footage-issue">
                  <p className="footage-issue-title footage-issue-error">
                    <span className="mono">{clipCount(current.cantFindCount)}</span>{" "}
                    {current.cantFindCount === 1 ? "has" : "have"} no usable sound
                  </p>
                  <p className="footage-issue-note">They will not come up when you ask for moments.</p>
                </div>
                <div className="footage-needs-actions">
                  <button
                    type="button"
                    className="ghost-btn label"
                    onClick={() => void handleRetryAllFailures()}
                    disabled={bulkRetryPending || snapshotLoading}
                  >
                    {bulkRetryPending ? "Retrying…" : "Try again"}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn label"
                    onClick={() => void handleExportFailuresCsv()}
                    disabled={csvExportPending}
                  >
                    {csvExportPending ? "Saving…" : "Save list"}
                  </button>
                  <button type="button" className="text-link footage-see-link" onClick={toggleFailuresExpanded}>
                    {failuresExpanded ? "Hide them" : "See them"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      default: {
        const exhaustive: never = phase;
        return exhaustive;
      }
    }
  }

  function renderUpdateRow() {
    switch (updateState.phase) {
      case "checking":
        return (
          <div className="u-row">
            <span className="u-state">
              <span className="dot spin" aria-hidden="true" />
              <span className="u-text">Checking for updates…</span>
            </span>
            <button className="ghost-btn label" disabled>
              Check now
            </button>
          </div>
        );
      case "downloading": {
        const total = updateState.total;
        const pct = total ? Math.min(100, Math.round(((updateState.transferred ?? 0) / total) * 100)) : 0;
        return (
          <div className="u-row">
            <span className="u-state">
              <span className="dot warn" aria-hidden="true" />
              <span className="u-text">
                Downloading <span className="mono">{updateState.availableVersion}</span>
              </span>
            </span>
            <span className="prog">
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="prog-label mono">
              {formatBytes(updateState.transferred)} / {formatBytes(updateState.total)}
            </span>
          </div>
        );
      }
      case "staging":
        return (
          <div className="u-row">
            <span className="u-state">
              <span className="dot warn" aria-hidden="true" />
              <span className="u-text">
                Preparing <span className="mono">{updateState.availableVersion}</span> — verifying the download…
              </span>
            </span>
          </div>
        );
      case "ready":
        return (
          <div className="u-row">
            <span className="u-state">
              <span className="dot red" aria-hidden="true" />
              <span className="u-text">
                <span className="mono">{updateState.availableVersion}</span> downloaded — restart to finish
              </span>
            </span>
            <button className="marker-btn" onClick={() => void api.restartToUpdate()}>
              Restart now
            </button>
            <button className="ghost-btn label" onClick={onDismissUpdate}>
              On next quit
            </button>
          </div>
        );
      case "error":
        return (
          <div className="u-row">
            <span className="u-state">
              <span className="dot err" aria-hidden="true" />
              <span className="u-text">{updateState.errorMessage ?? "Could not reach GitHub — retrying in an hour"}</span>
            </span>
            <button className="ghost-btn label" onClick={() => void api.checkForUpdates()}>
              Check now
            </button>
          </div>
        );
      case "idle":
      default:
        return (
          <>
            <div className="u-row">
              <span className="u-state">
                <span className="dot ok" aria-hidden="true" />
                <span className="u-text">
                  Dailies <span className="mono">{updateState.currentVersion}</span> — up to date
                </span>
              </span>
              <button className="ghost-btn label" onClick={() => void api.checkForUpdates()}>
                Check now
              </button>
            </div>
            <div className="u-meta mono">
              {updateState.lastCheckedAt ? `Checked ${formatCheckedAt(updateState.lastCheckedAt)} · ` : ""}
              checks at launch, hourly, and when the window comes to front
            </div>
          </>
        );
    }
  }

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
              <span className="panel-bar-title">Software update</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Updates</h2>
              {renderUpdateRow()}
            </div>
          </section>
          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Jobs</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Your footage</h2>

              {progressError && (
                <InlineError message={progressError} onRetry={() => void refreshProgress()} retrying={progressLoading} />
              )}

              {progress && renderPipelineProgress(progress)}
              {!progress && progressLoading && <p className="jobs-hint mono">Checking your footage…</p>}

              {waitingCount > 0 && (
                <p className="jobs-waiting-summary mono" role="status">
                  {waitingCount} {waitingCount === 1 ? "job is" : "jobs are"} paused until setup is complete. No retry is needed.
                </p>
              )}

              {failuresExpanded && (
                <div className="failures-block">
                  {snapshotError && (
                    <InlineError
                      message={snapshotError}
                      onRetry={() => void refreshSnapshot()}
                      retrying={snapshotLoading}
                    />
                  )}

                  {snapshot && (
                    <>
                      <div className="failures-head">
                        <h3 className="jobs-subhead label">Failed ({snapshot.failures.length})</h3>
                        {snapshot.failures.length > 0 && (
                          <div className="failures-actions">
                            <button
                              type="button"
                              className="ghost-btn label"
                              onClick={() => void handleBulkRetry()}
                              disabled={selectedFailureIds.size === 0 || bulkRetryPending}
                            >
                              {bulkRetryPending ? "Retrying…" : `Retry selected (${selectedFailureIds.size})`}
                            </button>
                            <button
                              type="button"
                              className="ghost-btn label"
                              onClick={() => void handleExportFailuresCsv()}
                              disabled={csvExportPending}
                            >
                              {csvExportPending ? "Exporting…" : "Export CSV"}
                            </button>
                          </div>
                        )}
                      </div>

                      {snapshot.failures.length === 0 ? (
                        <p className="jobs-empty mono">No failures.</p>
                      ) : (
                        <table className="jobs-table mono">
                          <thead>
                            <tr>
                              <th className="jobs-select-col">
                                <input
                                  type="checkbox"
                                  checked={selectedFailureIds.size === snapshot.failures.length}
                                  onChange={toggleAllFailuresSelected}
                                  aria-label="Select all failed files"
                                />
                              </th>
                              <th>File</th>
                              <th>Stage</th>
                              <th>Reason</th>
                              <th>Attempts</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.failures.map((failure) => (
                              <tr key={failure.fileId}>
                                <td className="jobs-select-col">
                                  <input
                                    type="checkbox"
                                    checked={selectedFailureIds.has(failure.fileId)}
                                    onChange={() => toggleFailureSelected(failure.fileId)}
                                    aria-label={`Select ${failure.filename}`}
                                  />
                                </td>
                                <td className="jobs-filename" title={failure.filename}>
                                  {failure.filename}
                                </td>
                                <td>{failure.stage}</td>
                                <td className="job-detail error">
                                  <span className="reason-line mono">{firstLine(failure.reason)}</span>
                                  {hasMoreLines(failure.reason) && (
                                    <button
                                      type="button"
                                      className="reason-toggle label"
                                      onClick={() => toggleFailureExpanded(failure.fileId)}
                                    >
                                      {expandedFailureIds.has(failure.fileId) ? "Hide full reason" : "Show full reason"}
                                    </button>
                                  )}
                                  {expandedFailureIds.has(failure.fileId) && (
                                    <pre className="reason-full mono">{failure.reason}</pre>
                                  )}
                                </td>
                                <td>{failure.attempts}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="job-retry label"
                                    onClick={() => void handleRetryFile(failure.fileId)}
                                    disabled={retryingFileIds.has(failure.fileId)}
                                  >
                                    {retryingFileIds.has(failure.fileId) ? "Retrying…" : "Retry"}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}

                  {!snapshot && snapshotLoading && (
                    <p className="jobs-hint mono">Loading clips with problems…</p>
                  )}
                </div>
              )}

              <button
                type="button"
                className="ghost-btn label jobs-history-toggle"
                onClick={() => setHistoryExpanded((v) => !v)}
              >
                {historyExpanded ? "Hide job history" : "Show job history"}
              </button>

              {historyExpanded && (
                <div className="jobs-history">
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
                            {job.status === "error" && job.error ? (
                              <>
                                <span className="reason-line mono">{firstLine(job.error)}</span>
                                {hasMoreLines(job.error) && (
                                  <button
                                    type="button"
                                    className="reason-toggle label"
                                    onClick={() => toggleJobExpanded(job.id)}
                                  >
                                    {expandedJobIds.has(job.id) ? "Hide full reason" : "Show full reason"}
                                  </button>
                                )}
                                {expandedJobIds.has(job.id) && <pre className="reason-full mono">{job.error}</pre>}
                              </>
                            ) : (
                              <span>{job.status === "waiting" ? waitingMessage(job) : "—"}</span>
                            )}
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
              )}
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
                {episodes.map((ep) => {
                  const report = episodeReports[ep.id] ?? null;
                  const source = report?.source ?? ep.membershipSource;
                  const isExpanded = expandedEpisodeId === ep.id;
                  return (
                    <div key={ep.id} className="episode-row-wrap">
                      <div className="folder-row">
                        <span className="folder-path-row">
                          <span className="mono episode-code">{ep.code}</span>
                          <span className="episode-source-tag label">{MEMBERSHIP_SOURCE_LABEL[source]}</span>
                          <span className="episode-count mono">
                            {report ? `${report.memberCount} ${report.memberCount === 1 ? "member" : "members"}` : "…"}
                          </span>
                          {report && report.unresolvedCount > 0 && (
                            <span className="episode-unresolved mono">{report.unresolvedCount} unresolved</span>
                          )}
                          <span className="folder-scanned mono">{formatDate(ep.createdAt)}</span>
                        </span>
                        <button
                          type="button"
                          className="ghost-btn label"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedEpisodeId(isExpanded ? null : ep.id)}
                        >
                          {isExpanded ? "Close" : "Manage"}
                        </button>
                      </div>
                      {isExpanded && (
                        <EpisodeMembershipPanel
                          episode={ep}
                          report={report}
                          onSourceChange={(next) => handleSetMembershipSource(ep.id, next)}
                          onImport={(input) => handleImportClipList(ep.id, input)}
                        />
                      )}
                    </div>
                  );
                })}
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
                <button
                  className="ghost-btn label"
                  onClick={() => void handleDetectEpisodes()}
                  disabled={detecting}
                >
                  {detecting ? "Reading media…" : "Detect episodes from media"}
                </button>
              </div>
              {detectNotice && <p className="jobs-hint mono">{detectNotice}</p>}
              {proposal && (
                <div style={{ marginTop: 14 }}>
                  <EpisodeProposalCard
                    proposal={proposal}
                    onApply={handleApplyProposal}
                    onDismiss={() => setProposal(null)}
                    onRefresh={() => void handleDetectEpisodes()}
                  />
                </div>
              )}
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">API key</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              {settings?.apiKeyStatus === "managed" && (
                <p className="jobs-hint">
                  Models are provided for this beta. Add your own key below to use
                  your own OpenRouter account instead.
                </p>
              )}
              <ApiKeyField
                label="OpenRouter API key"
                connected={settings?.apiKeyStatus === "connected"}
                value={openRouterKey}
                onChange={setOpenRouterKey}
                onSave={() => handleSaveKey("openrouter")}
                saving={savingProvider === "openrouter"}
              />
              {settings?.apiKeyStatus !== "managed" && (
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
              )}
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
                Everything transcribes on this computer. Audio never leaves the machine.
              </p>
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Model</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Model</h2>
              <div className="trans-row">
                <span className="trans-name">Chat model</span>
                <span className="trans-status mono">{chatModelOption(settings?.chatModelId).id}</span>
              </div>
              <div className="trans-row">
                <span className="trans-name">Embedding model</span>
                <span className="trans-status mono">{EMBEDDING_MODEL}</span>
              </div>
            </div>
          </section>

          <section className="jobs-section">
            <div className="panel-bar">
              <span className="panel-bar-close" aria-hidden="true" />
              <span className="panel-bar-title">Privacy</span>
              <span className="panel-bar-stripes" aria-hidden="true" />
            </div>
            <div className="panel-body">
              <h2 className="display panel-title">Usage data</h2>
              <p className="jobs-hint mono" style={{ marginTop: 0, marginBottom: 14 }}>
                When usage-data sharing is on, Dailies sends activity logs to the developer to help fix problems: error reports, job events, clip names, and file names, with an anonymous install and session id. It never sends your media, audio, or transcripts. Turn it off to stop sending immediately.
              </p>
              <div className="trans-row">
                <span className="trans-name">Usage data</span>
                <div className="segmented-toggle" role="group" aria-label="Usage data">
                  <button
                    type="button"
                    className={`segmented-btn label${settings?.telemetryEnabled ? " active" : ""}`}
                    onClick={() => void handleSetTelemetry(true)}
                    disabled={telemetryPending || settings?.telemetryEnabled === true}
                  >
                    On
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn label${settings?.telemetryEnabled === false ? " active" : ""}`}
                    onClick={() => void handleSetTelemetry(false)}
                    disabled={telemetryPending || settings?.telemetryEnabled === false}
                  >
                    Off
                  </button>
                </div>
              </div>
              <div className="trans-row">
                <span className="trans-name">Diagnostics export</span>
                <button
                  className="ghost-btn label"
                  onClick={() => void handleExportDiagnostics()}
                  disabled={diagnosticsPending}
                >
                  {diagnosticsPending ? "Exporting…" : "Export diagnostics"}
                </button>
              </div>
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

      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}

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
        .u-row {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-wrap: wrap;
          padding: 11px 12px;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
        }
        .u-row + .u-meta {
          margin-top: 7px;
        }
        .u-state {
          display: flex;
          align-items: center;
          gap: 9px;
          flex: 1;
          min-width: 220px;
        }
        .u-state .dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          flex: none;
          border: 1px solid rgba(23, 25, 27, 0.35);
        }
        .u-state .dot.ok {
          background: var(--status-ok);
        }
        .u-state .dot.warn {
          background: var(--status-warn);
        }
        .u-state .dot.err {
          background: var(--status-error);
        }
        .u-state .dot.red {
          background: var(--marker-red);
        }
        .u-state .dot.spin {
          background: conic-gradient(var(--accent) 0 25%, var(--paper-alt) 25% 100%);
          animation: update-dot-tick 1s steps(4) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .u-state .dot.spin {
            animation: none;
          }
        }
        @keyframes update-dot-tick {
          to {
            transform: rotate(360deg);
          }
        }
        .u-text {
          font-size: 14px;
          font-weight: 500;
          color: var(--ink);
        }
        .u-meta {
          font-size: 11px;
          color: var(--ink-dim);
        }
        .prog {
          flex: 1;
          min-width: 140px;
          height: 10px;
          background: var(--paper-alt);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          position: relative;
        }
        .prog > i {
          position: absolute;
          inset: 1px auto 1px 1px;
          background: var(--accent);
        }
        .prog-label {
          font-size: 11px;
          color: var(--ink-dim);
          white-space: nowrap;
        }
        .marker-btn {
          font-family: var(--font-body);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #fff;
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          border-radius: 2px;
          padding: 9px 16px;
          cursor: pointer;
          box-shadow:
            inset 1px 1px 0 rgba(255, 255, 255, 0.25),
            inset -1px -1px 0 rgba(0, 0, 0, 0.2),
            1px 2px 0 rgba(23, 25, 27, 0.28);
        }
        .marker-btn:active {
          box-shadow: inset 1px 1px 0 rgba(0, 0, 0, 0.2);
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
          margin: 16px 0 0;
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
        .reason-line {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 280px;
        }
        .reason-toggle {
          display: block;
          margin-top: 4px;
          background: none;
          border: none;
          padding: 0;
          color: var(--ink-faint);
          font-size: 9px;
          text-decoration: underline;
          cursor: pointer;
        }
        .reason-toggle:hover {
          color: var(--accent);
        }
        .reason-full {
          margin: 6px 0 0;
          padding: 8px 9px;
          max-width: 280px;
          max-height: 140px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          background: var(--paper-alt);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          font-size: 10.5px;
          color: var(--status-error);
        }
        .job-detail.waiting .reason-full {
          color: var(--status-warn);
        }
        .jobs-empty {
          color: var(--ink-faint);
          padding: 16px 0;
        }
        .jobs-select-col {
          width: 28px;
        }
        .jobs-select-col input {
          accent-color: var(--accent);
        }
        .footage-state {
          color: var(--ink);
        }
        .footage-lede {
          margin: 0;
          font-family: var(--font-display);
          font-size: 24px;
          font-weight: 700;
          line-height: 1.15;
          letter-spacing: -0.02em;
        }
        .footage-lede-ready {
          display: flex;
          align-items: center;
          gap: 9px;
        }
        .footage-ready-mark {
          color: var(--status-ok);
          font-size: 21px;
          line-height: 1;
        }
        .footage-sub {
          max-width: 68ch;
          margin: 7px 0 17px;
          color: var(--ink-dim);
          font-size: 13px;
          line-height: 1.5;
        }
        .footage-progress {
          position: relative;
          width: 100%;
          height: 8px;
          overflow: hidden;
          background: var(--paper-alt);
          border: 1px solid var(--chrome-lo);
          border-radius: 1px;
          box-shadow: var(--bevel-in);
        }
        .footage-progress-fill {
          display: block;
          height: 100%;
          width: 0;
          background: var(--accent);
        }
        .footage-progress-fill-starting {
          width: 10%;
          opacity: 0.58;
        }
        .footage-progress-fill-ready {
          width: 100%;
          background: var(--status-ok);
        }
        .footage-count {
          margin: 7px 0 19px;
          color: var(--ink-dim);
          font-size: 11px;
        }
        .footage-secondary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          min-height: 46px;
          padding: 11px 13px;
          background: var(--paper-alt);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-in);
          color: var(--ink-dim);
          font-size: 12px;
        }
        .footage-secondary-eta {
          max-width: 290px;
          color: var(--ink);
          font-size: 11px;
          text-align: right;
        }
        .footage-problems-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-top: 15px;
          padding-top: 13px;
          border-top: 1px solid var(--hairline-strong);
        }
        .footage-problems-count {
          color: var(--ink-dim);
          font-size: 11px;
        }
        .footage-metrics {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin-top: 18px;
        }
        .footage-metric {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 12px 14px;
          background: var(--paper-alt);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-in);
        }
        .footage-metric-label {
          color: var(--ink-dim);
          font-size: 9.5px;
          font-weight: 600;
          letter-spacing: 0.08em;
        }
        .footage-metric-value {
          color: var(--ink);
          font-size: 22px;
          font-weight: 700;
          line-height: 1;
        }
        .footage-needs-look {
          margin-top: 16px;
          padding: 14px;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-in);
        }
        .footage-needs-title {
          margin: 0 0 11px;
          color: var(--ink);
          font-size: 14px;
          font-weight: 700;
        }
        .footage-issue {
          padding: 10px 0;
          border-top: 1px solid var(--hairline);
        }
        .footage-issue-title,
        .footage-issue-note {
          margin: 0;
        }
        .footage-issue-title {
          font-size: 12px;
          font-weight: 600;
        }
        .footage-issue-warn {
          color: var(--status-warn);
        }
        .footage-issue-error {
          color: var(--status-error);
        }
        .footage-issue-note {
          margin-top: 4px;
          color: var(--ink-dim);
          font-size: 10.5px;
          line-height: 1.45;
        }
        .footage-needs-actions {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          padding-top: 5px;
        }
        .footage-see-link {
          margin-left: 3px;
          font-size: 11px;
        }
        .jobs-subhead {
          font-size: 10.5px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--ink-dim);
          margin: 0;
        }
        .failures-block {
          margin-top: 18px;
          padding-top: 18px;
          overflow-x: auto;
          border-top: 1px solid var(--hairline-strong);
        }
        .failures-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 10px;
        }
        .failures-actions {
          display: flex;
          gap: 8px;
        }
        .jobs-history-toggle {
          margin-top: 20px;
        }
        .jobs-history {
          margin-top: 14px;
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
          flex-wrap: wrap;
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
        .segmented-toggle {
          display: inline-flex;
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          overflow: hidden;
          box-shadow: var(--bevel-in);
        }
        .segmented-btn {
          font-family: var(--font-body);
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--ink-faint);
          background: var(--ground-raised);
          border: none;
          padding: 7px 14px;
          cursor: pointer;
        }
        .segmented-btn + .segmented-btn {
          border-left: 1px solid var(--chrome-lo);
        }
        .segmented-btn.active {
          background: var(--select-bg);
          color: var(--select-ink);
        }
        .segmented-btn:disabled {
          cursor: default;
        }
        .segmented-btn:hover:not(.active):not(:disabled) {
          background: #d2d6d9;
          color: var(--ink-dim);
        }
        .episode-row-wrap {
          display: flex;
          flex-direction: column;
        }
        .episode-source-tag {
          color: var(--ink-dimmer);
          font-size: 9.5px;
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          padding: 2px 6px;
        }
        .episode-count {
          font-size: 10.5px;
          color: var(--ink-dim);
        }
        .episode-unresolved {
          font-size: 10.5px;
          color: var(--status-warn);
          border: 1px solid var(--status-warn);
          border-radius: 2px;
          padding: 1px 6px;
        }
        .episode-panel {
          margin: 2px 0 14px;
          padding: 16px;
          background: var(--ground-card, #fff);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .episode-panel-row {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .episode-panel-hint {
          font-size: 10.5px;
          color: var(--ink-faint);
          margin: 0;
          line-height: 1.5;
        }
        .episode-panel-error {
          font-size: 11px;
          color: var(--status-error);
          margin: 0;
        }
        .episode-drop {
          border: 1px dashed var(--chrome-lo);
          border-radius: 2px;
          padding: 16px;
          text-align: center;
          background: #fff;
        }
        .episode-drop.over {
          border-color: var(--accent);
        }
        .episode-drop-text {
          font-size: 11px;
          color: var(--ink-dim);
          margin: 0;
        }
        .episode-drop-choose {
          margin-left: 4px;
          background: none;
          border: none;
          padding: 0;
          color: var(--accent);
          text-decoration: underline;
          cursor: pointer;
          font-size: 11px;
        }
        .episode-file-input {
          display: none;
        }
        .episode-paste-label {
          display: block;
        }
        .episode-paste {
          width: 100%;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          padding: 9px 12px;
          color: var(--ink);
          font-size: 12px;
          resize: vertical;
        }
        .episode-paste:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .episode-diagnostics {
          background: rgba(158, 58, 48, 0.08);
          border: 1px solid var(--status-error);
          border-radius: 2px;
          padding: 8px 10px;
        }
        .episode-diagnostics-list {
          margin: 6px 0 0;
          padding-left: 16px;
          color: var(--status-error);
          font-size: 11px;
        }
        .episode-panel-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .episode-confirm {
          background: #fff;
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .episode-confirm p {
          margin: 0;
          font-size: 11.5px;
          color: var(--ink);
          line-height: 1.5;
        }
        .episode-confirm-btn {
          font-family: var(--font-body);
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          background: var(--select-bg);
          color: var(--select-ink);
          border: 1px solid var(--select-bg);
          border-radius: 2px;
          padding: 8px 14px;
          cursor: pointer;
        }
        .episode-confirm-btn:hover:not(:disabled) {
          opacity: 0.88;
        }
        .episode-confirm-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .episode-report {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .episode-report-summary {
          font-size: 11px;
          color: var(--ink-dim);
        }
        .episode-report-raw {
          color: var(--ink);
          word-break: break-word;
          white-space: normal;
        }
        .episode-candidates {
          margin: 0;
          padding-left: 14px;
        }
        .episode-candidates li {
          color: var(--ink-dim);
        }
        .episode-report-dash {
          color: var(--ink-faint);
        }
        @media (max-width: 640px) {
          .jobs-scroll {
            padding: 18px 12px 48px;
          }
          .jobs-column {
            gap: 16px;
          }
          .panel-body {
            margin: 6px;
            padding: 18px 14px 20px;
          }
          .footage-lede {
            font-size: 20px;
          }
          .footage-secondary {
            align-items: flex-start;
            flex-direction: column;
            gap: 6px;
          }
          .footage-secondary-eta {
            max-width: none;
            text-align: left;
          }
          .footage-problems-row,
          .failures-head {
            align-items: flex-start;
            flex-direction: column;
          }
          .failures-actions {
            flex-wrap: wrap;
          }
          .failures-block .jobs-table {
            min-width: 680px;
          }
        }
        @media (max-width: 380px) {
          .footage-metrics {
            grid-template-columns: 1fr;
          }
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

interface EpisodeMembershipPanelProps {
  episode: Episode;
  report: EpisodeMembershipReport | null;
  onSourceChange: (source: MembershipSource) => Promise<void>;
  onImport: (input: ClipListInput) => Promise<EpisodeMembershipReport | ClipListImportBlocked>;
}

function EpisodeMembershipPanel({ episode, report, onSourceChange, onImport }: EpisodeMembershipPanelProps) {
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftSourceName, setDraftSourceName] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ClipListImportDiagnostic[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const source = report?.source ?? episode.membershipSource;
  const lineCount = draftText.trim().length > 0 ? countNonBlankLines(draftText) : 0;

  async function handleSource(next: MembershipSource) {
    if (next === source || sourcePending) return;
    setSourcePending(true);
    setSourceError(null);
    try {
      await onSourceChange(next);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : `Could not switch to ${MEMBERSHIP_SOURCE_LABEL[next]}.`);
    } finally {
      setSourcePending(false);
    }
  }

  function loadFileText(file: File, sourceName: string) {
    file
      .text()
      .then((text) => {
        setDraftText(text);
        setDraftSourceName(sourceName);
        setConfirming(false);
        setDiagnostics(null);
        setImportError(null);
      })
      .catch(() => {
        setImportError(`Could not read ${sourceName}.`);
      });
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFileText(file, file.name);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFileText(file, file.name);
    e.target.value = "";
  }

  function handlePasteChange(value: string) {
    setDraftText(value);
    setDraftSourceName(null);
    setConfirming(false);
    setDiagnostics(null);
    setImportError(null);
  }

  async function commitImport() {
    setImporting(true);
    setImportError(null);
    try {
      const input: ClipListInput = draftSourceName
        ? { kind: "file", sourceName: draftSourceName, text: draftText }
        : { kind: "paste", text: draftText };
      const result = await onImport(input);
      if (isBlockedImport(result)) {
        setDiagnostics(result.diagnostics);
        setConfirming(false);
        return;
      }
      setDiagnostics(null);
      setConfirming(false);
      setDraftText("");
      setDraftSourceName(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Could not replace the clip list.");
      setConfirming(false);
    } finally {
      setImporting(false);
    }
  }

  const resolutions = report?.resolutions ?? [];

  return (
    <div className="episode-panel">
      <div className="episode-panel-row">
        <span className="label">Membership source</span>
        <div className="segmented-toggle" role="group" aria-label={`Membership source for episode ${episode.code}`}>
          <button
            type="button"
            className={`segmented-btn label${source === "folder" ? " active" : ""}`}
            onClick={() => void handleSource("folder")}
            disabled={sourcePending}
          >
            Folders
          </button>
          <button
            type="button"
            className={`segmented-btn label${source === "list" ? " active" : ""}`}
            onClick={() => void handleSource("list")}
            disabled={sourcePending}
          >
            Clip list
          </button>
          <button
            type="button"
            className={`segmented-btn label${source === "media-tag" ? " active" : ""}`}
            onClick={() => void handleSource("media-tag")}
            disabled={sourcePending || episode.mediaTag === null}
            title={
              episode.mediaTag === null
                ? "This episode has no Avid project tag yet."
                : `Avid project ${episode.mediaTag}`
            }
          >
            Media tags
          </button>
        </div>
      </div>
      <p className="episode-panel-hint mono">
        Watched folders still decide what Dailies indexes. This source decides which indexed clips belong to episode{" "}
        {episode.code}. Switching sources does not delete stored list entries.
      </p>
      {episode.mediaTag === null ? (
        <p className="episode-panel-hint mono">
          This episode has no Avid project tag, so media tags cannot decide its members.
        </p>
      ) : (
        source === "media-tag" && (
          <p className="episode-panel-hint mono">
            Clips whose Avid project is {episode.mediaTag} belong to this episode.
          </p>
        )
      )}
      {sourceError && <p className="episode-panel-error mono">{sourceError}</p>}

      {source === "list" && (
        <>
          <div
            className={`episode-drop${dragOver ? " over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <p className="episode-drop-text mono">
              Drop an ALE, EDL, or CSV file, or{" "}
              <button type="button" className="episode-drop-choose" onClick={() => fileInputRef.current?.click()}>
                choose a file
              </button>
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".ale,.edl,.csv,.txt"
              className="episode-file-input"
              onChange={handleFileInput}
              aria-label={`Clip list file for episode ${episode.code}`}
            />
          </div>

          <label className="episode-panel-hint label episode-paste-label" htmlFor={`episode-paste-${episode.id}`}>
            Or paste clip names, one per line
          </label>
          <textarea
            id={`episode-paste-${episode.id}`}
            className="episode-paste mono"
            rows={4}
            placeholder={"A002_C003_0716\nA002_C009_0716_b\n…"}
            value={draftText}
            onChange={(e) => handlePasteChange(e.target.value)}
          />
          {draftText.trim().length > 0 && (
            <p className="episode-panel-hint mono">
              {draftSourceName ? `From ${draftSourceName} · ` : ""}
              {lineCount} {lineCount === 1 ? "line" : "lines"} ready
            </p>
          )}

          {diagnostics && diagnostics.length > 0 && (
            <div className="episode-diagnostics">
              <span className="label">Could not import</span>
              <ul className="episode-diagnostics-list mono">
                {diagnostics.map((d, i) => (
                  <li key={i}>
                    {d.sourceName}:{d.line} — {d.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {importError && <p className="episode-panel-error mono">{importError}</p>}

          {!confirming ? (
            <div className="episode-panel-actions">
              <button
                type="button"
                className="ghost-btn label"
                disabled={lineCount === 0 || importing}
                onClick={() => setConfirming(true)}
              >
                Replace list…
              </button>
            </div>
          ) : (
            <div className="episode-confirm mono">
              <p>
                Replace the stored clip list for episode {episode.code} with {lineCount}{" "}
                {lineCount === 1 ? "line" : "lines"}
                {draftSourceName ? ` from ${draftSourceName}` : ""}? Previously matched, ambiguous, and unmatched
                entries will be replaced.
              </p>
              <div className="episode-panel-actions">
                <button
                  type="button"
                  className="episode-confirm-btn label"
                  onClick={() => void commitImport()}
                  disabled={importing}
                >
                  {importing ? "Replacing…" : "Replace list"}
                </button>
                <button
                  type="button"
                  className="ghost-btn label"
                  onClick={() => setConfirming(false)}
                  disabled={importing}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {report && (
        <div className="episode-report">
          <div className="episode-report-summary mono">
            {source === "media-tag" ? (
              <>
                {report.matchedCount} matched
                {report.untaggedClipCount !== undefined && report.untaggedClipCount > 0 && (
                  <> · {report.untaggedClipCount} clips have no project tag</>
                )}
              </>
            ) : (
              <>
                {report.matchedCount} matched · {report.ambiguousCount} ambiguous ·{" "}
                {report.unmatchedCount} not found
              </>
            )}
          </div>
          {resolutions.length > 0 ? (
            <table className="jobs-table mono">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Input name</th>
                  <th>Status</th>
                  <th>Resolved to</th>
                </tr>
              </thead>
              <tbody>
                {resolutions.map((r) => (
                  <tr key={r.ordinal}>
                    <td>{r.ordinal + 1}</td>
                    <td className="episode-report-raw">{r.rawName}</td>
                    <td>
                      <span className="job-status">
                        <span className="job-status-dot" style={{ background: RESOLUTION_COLOR[r.kind] }} />
                        {RESOLUTION_LABEL[r.kind]}
                      </span>
                    </td>
                    <td>
                      {r.kind === "matched" && r.displayName}
                      {r.kind === "ambiguous" && (
                        <ul className="episode-candidates">
                          {r.candidates.map((c) => (
                            <li key={c.fileId}>{c.displayName}</li>
                          ))}
                        </ul>
                      )}
                      {r.kind === "unmatched" && <span className="episode-report-dash">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            source === "list" && <p className="jobs-empty mono">No list entries imported yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
