/**
 * Full in-browser mock of DailiesAPI so `vite dev` runs with no Electron.
 */
import type { ClipListImportBlocked, DailiesAPI } from "../../shared/ipc";
import type {
  AppSettings,
  ClipListInput,
  EpisodeMembershipReport,
  MembershipSource,
  ModelDownloadProgress,
  ChatEvent,
  ChatScope,
  Episode,
  EpisodeMembershipResolution,
  ExportItem,
  ExportKind,
  ExportWriteOutcome,
  FileDetail,
  IndexUpdate,
  LocatorExportOutcome,
  MediaRole,
  PipelineActiveFile,
  PipelineCounts,
  PipelineFailure,
  PipelineSnapshot,
  Project,
  ProjectActivity,
  ProjectFolder,
  ProjectState,
  UpdaterState,
  WordTiming,
} from "../../shared/types";
import { chatModelSelection, normalizeClipName } from "../../shared/types";
import {
  AGENT_STAGES,
  buildMockAnswer,
  getFileDetail,
  MOCK_CHAT_MESSAGES,
  MOCK_CHATS,
  MOCK_EPISODES,
  MOCK_FILES,
  MOCK_FOLDERS,
  MOCK_JOBS,
  MOCK_EPISODE_MEMBERS,
  MOCK_MEMBERSHIP_REPORTS,
  MOCK_PROJECTS,
  MOCK_SETTINGS,
  MOCK_UPDATE_AVAILABLE_VERSION,
  MOCK_UPDATE_CURRENT_VERSION,
  MOCK_UPDATE_TOTAL_BYTES,
} from "./data";

type Listener = (ev: ChatEvent) => void;

const modelProgressListeners = new Set<(p: ModelDownloadProgress) => void>();

// ---------- software update (dev-only demo) ----------
// Renderer-only dev mode (`npm run dev:renderer`) has no main process, so
// there is no real update feed. This stands in for one: "Check now" walks
// checking -> downloading -> staging -> ready like a real release, and
// window.__mockUpdaterPhase(phase) forces any of the states instantly
// for visual QA. Starts idle, per the approved mock.
let updateState: UpdaterState = {
  phase: "idle",
  currentVersion: MOCK_UPDATE_CURRENT_VERSION,
  lastCheckedAt: Date.now() - 5 * 60 * 1000,
};
const updateStateListeners = new Set<(s: UpdaterState) => void>();
let updateTimer: ReturnType<typeof setTimeout> | null = null;

function pushUpdateState(patch: Partial<UpdaterState>): void {
  updateState = { ...updateState, ...patch };
  updateStateListeners.forEach((cb) => cb(updateState));
}

function clearUpdateTimer(): void {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = null;
}

function tickMockDownload(): void {
  const transferred = Math.min(MOCK_UPDATE_TOTAL_BYTES, (updateState.transferred ?? 0) + MOCK_UPDATE_TOTAL_BYTES / 6);
  if (transferred >= MOCK_UPDATE_TOTAL_BYTES) {
    // Mirror the real pipeline: Squirrel staging/validation between the
    // download finishing and restart actually being possible.
    pushUpdateState({ phase: "staging", transferred: undefined, total: undefined });
    updateTimer = setTimeout(() => {
      pushUpdateState({ phase: "ready" });
    }, 1400);
    return;
  }
  pushUpdateState({ transferred });
  updateTimer = setTimeout(tickMockDownload, 450);
}

function runMockCheck(): void {
  clearUpdateTimer();
  pushUpdateState({ phase: "checking" });
  updateTimer = setTimeout(() => {
    pushUpdateState({
      phase: "downloading",
      availableVersion: MOCK_UPDATE_AVAILABLE_VERSION,
      transferred: 0,
      total: MOCK_UPDATE_TOTAL_BYTES,
    });
    tickMockDownload();
  }, 850);
}

declare global {
  interface Window {
    /** Dev-only: force any updater phase for visual QA (see mock/api.ts). */
    __mockUpdaterPhase?: (phase: UpdaterState["phase"]) => void;
  }
}

if (typeof window !== "undefined") {
  window.__mockUpdaterPhase = (phase) => {
    clearUpdateTimer();
    if (phase === "idle") {
      pushUpdateState({
        phase: "idle",
        lastCheckedAt: Date.now(),
        errorMessage: undefined,
        availableVersion: undefined,
        transferred: undefined,
        total: undefined,
      });
    } else if (phase === "checking") {
      pushUpdateState({ phase: "checking" });
    } else if (phase === "downloading") {
      pushUpdateState({
        phase: "downloading",
        availableVersion: MOCK_UPDATE_AVAILABLE_VERSION,
        transferred: Math.round(MOCK_UPDATE_TOTAL_BYTES * 0.37),
        total: MOCK_UPDATE_TOTAL_BYTES,
      });
    } else if (phase === "staging") {
      pushUpdateState({
        phase: "staging",
        availableVersion: MOCK_UPDATE_AVAILABLE_VERSION,
        transferred: undefined,
        total: undefined,
      });
    } else if (phase === "ready") {
      pushUpdateState({
        phase: "ready",
        availableVersion: MOCK_UPDATE_AVAILABLE_VERSION,
        transferred: MOCK_UPDATE_TOTAL_BYTES,
        total: MOCK_UPDATE_TOTAL_BYTES,
      });
    } else if (phase === "error") {
      pushUpdateState({
        phase: "error",
        errorMessage: "Could not reach GitHub — retrying in an hour",
        lastCheckedAt: Date.now(),
      });
    }
  };
}

/**
 * The mock's stand-in for app-settings.json: keeps the chat model selection
 * across browser reloads. Stored raw; resolution happens on load.
 */
const MOCK_CHAT_MODEL_KEY = "dailies-mock-chat-model";

function loadStoredChatModel(): Pick<AppSettings, "chatModelId" | "chatEffort"> | null {
  try {
    const raw = window.localStorage.getItem(MOCK_CHAT_MODEL_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const id =
      "chatModelId" in parsed && typeof parsed.chatModelId === "string" ? parsed.chatModelId : null;
    const effort =
      "chatEffort" in parsed && typeof parsed.chatEffort === "string" ? parsed.chatEffort : null;
    const selection = chatModelSelection(id, effort);
    return { chatModelId: selection.option.id, chatEffort: selection.effort };
  } catch {
    return null;
  }
}

function storeChatModel(chatModelId: string, chatEffort: AppSettings["chatEffort"]): void {
  try {
    window.localStorage.setItem(MOCK_CHAT_MODEL_KEY, JSON.stringify({ chatModelId, chatEffort }));
  } catch {
    /* storage unavailable — selection lasts for the session only */
  }
}

export function createMockApi(): DailiesAPI {
  const listeners = new Set<Listener>();
  const projectUpdateListeners = new Set<() => void>();
  const indexUpdateListeners = new Set<(update: IndexUpdate) => void>();
  let indexRevision = 0;
  let nextChatId = MOCK_CHATS.length + 1;
  let settings = { ...MOCK_SETTINGS, ...loadStoredChatModel() };

  // Mutable in-memory copies so add/remove/rescan/create operations persist for the session.
  const projects: Project[] = MOCK_PROJECTS.map((p) => ({ ...p }));
  const episodesByProject: Record<string, Episode[]> = Object.fromEntries(
    Object.entries(MOCK_EPISODES).map(([id, eps]) => [id, eps.map((e) => ({ ...e }))]),
  );
  const foldersByProject: Record<string, ProjectFolder[]> = Object.fromEntries(
    Object.entries(MOCK_FOLDERS).map(([id, folders]) => [id, folders.map((f) => ({ ...f }))]),
  );
  const episodeMembers = new Map(
    [...MOCK_EPISODE_MEMBERS].map(([episodeId, fileIds]) => [episodeId, new Set(fileIds)]),
  );
  const membershipReports = new Map(
    [...MOCK_MEMBERSHIP_REPORTS].map(([episodeId, report]) => [
      episodeId,
      { ...report, resolutions: [...report.resolutions] },
    ]),
  );
  let nextEpisodeId = Math.max(0, ...Object.values(episodesByProject).flat().map((e) => e.id)) + 1;
  let nextFolderId = Math.max(0, ...Object.values(foldersByProject).flat().map((f) => f.id)) + 1;

  // The currently open project — defaults to "duck-dynasty" so the app starts populated.
  let currentProjectId: string | null = "duck-dynasty";

  function emit(ev: ChatEvent): void {
    listeners.forEach((cb) => cb(ev));
  }

  function notifyProjectUpdate(): void {
    projectUpdateListeners.forEach((cb) => cb());
  }

  function notifyIndexUpdate(): void {
    const update = { revision: ++indexRevision };
    indexUpdateListeners.forEach((cb) => cb(update));
  }

  function buildProjectState(): ProjectState | null {
    if (!currentProjectId) return null;
    const project = projects.find((p) => p.id === currentProjectId);
    if (!project) return null;
    return {
      project,
      episodes: episodesByProject[currentProjectId] ?? [],
      folders: foldersByProject[currentProjectId] ?? [],
    };
  }

  function filesForScope(scope: ChatScope) {
    return scope.episodeId === null
      ? MOCK_FILES
      : MOCK_FILES.filter((file) => episodeMembers.get(scope.episodeId ?? -1)?.has(file.id));
  }

  async function getEpisodeMembership(episodeId: number): Promise<EpisodeMembershipReport> {
    const report = membershipReports.get(episodeId);
    if (!report) throw new Error(`Unknown episode ${episodeId}`);
    return report;
  }

  async function setEpisodeMembershipSource(
    episodeId: number,
    source: MembershipSource,
  ): Promise<EpisodeMembershipReport> {
    const report = await getEpisodeMembership(episodeId);
    const next = { ...report, source };
    membershipReports.set(episodeId, next);
    return next;
  }

  async function replaceEpisodeClipList(
    episodeId: number,
    input: ClipListInput,
  ): Promise<EpisodeMembershipReport | ClipListImportBlocked> {
    const sourceName = input.kind === "file" ? input.sourceName : "Pasted clip list";
    const rows = input.text
      .split(/\r\n|\n|\r/)
      .map((row) => row.trim())
      .filter((row) => row !== "");
    const first = normalizeClipName(rows[0] ?? "");
    const names = input.kind === "file" &&
        ["clip", "clip name", "name", "key", "umid"].includes(first)
      ? rows.slice(1)
      : rows;
    if (names.length === 0) {
      return {
        kind: "blocked",
        diagnostics: [{
          sourceName,
          line: 1,
          message: `${sourceName} has no clip rows`,
        }],
      };
    }

    const resolutions: EpisodeMembershipResolution[] = names.map((rawName, ordinal) => {
      const normalized = normalizeClipName(rawName.replace(/^"|"$/g, ""));
      const exactMatches = MOCK_FILES.filter((file) => {
        const filenameStem = file.filename.replace(/\.[^.]+$/, "");
        return [file.clipName, filenameStem]
          .filter((name): name is string => name !== null)
          .some((name) => normalizeClipName(name) === normalized);
      });
      const candidates = exactMatches.length > 0
        ? exactMatches
        : MOCK_FILES.filter((file) => {
            const displayName = normalizeClipName(file.clipName ?? file.filename);
            return normalized.split(/\s+/).every((token) => displayName.includes(token));
          });
      if (candidates.length === 1) {
        const file = candidates[0];
        if (!file) throw new Error("Missing mock membership candidate");
        return {
          kind: "matched",
          ordinal,
          rawName,
          fileId: file.id,
          displayName: file.clipName ?? file.filename,
        };
      }
      if (candidates.length > 1) {
        return {
          kind: "ambiguous",
          ordinal,
          rawName,
          candidates: candidates.map((file) => ({
            fileId: file.id,
            displayName: file.clipName ?? file.filename,
          })),
        };
      }
      return { kind: "unmatched", ordinal, rawName };
    });
    const matchedFileIds = new Set(
      resolutions
        .filter((resolution) => resolution.kind === "matched")
        .map((resolution) => resolution.fileId),
    );
    const ambiguousCount = resolutions.filter(
      (resolution) => resolution.kind === "ambiguous",
    ).length;
    const unmatchedCount = resolutions.filter(
      (resolution) => resolution.kind === "unmatched",
    ).length;
    const report: EpisodeMembershipReport = {
      episodeId,
      source: "list",
      memberCount: matchedFileIds.size,
      matchedCount: resolutions.length - ambiguousCount - unmatchedCount,
      ambiguousCount,
      unmatchedCount,
      unresolvedCount: ambiguousCount + unmatchedCount,
      resolutions,
    };
    episodeMembers.set(episodeId, matchedFileIds);
    membershipReports.set(episodeId, report);
    return report;
  }

  function buildPipelineSnapshot(scope: ChatScope): PipelineSnapshot {
    const files = filesForScope(scope);
    const fileIds = new Set(files.map((file) => file.id));
    const counts: PipelineCounts = { queued: 0, processing: 0, done: 0, failed: 0 };
    for (const file of files) {
      if (file.status === "error") counts.failed += 1;
      else if (file.status === "ready") counts.done += 1;
      else if (file.status === "processing") counts.processing += 1;
      else counts.queued += 1;
    }
    const activeFiles: PipelineActiveFile[] = MOCK_JOBS
      .filter((job) => job.status === "running" && fileIds.has(job.fileId))
      .map((job) => ({ fileId: job.fileId, filename: job.filename, stage: job.stage }));
    const pendingFileIds = [...new Set(
      MOCK_JOBS
        .filter((job) =>
          fileIds.has(job.fileId) &&
          (job.status === "queued" || job.status === "running" || job.status === "waiting")
        )
        .map((job) => job.fileId),
    )];
    const failures: PipelineFailure[] = MOCK_JOBS
      .filter((job) => job.status === "error" && fileIds.has(job.fileId))
      .map((job) => ({
        fileId: job.fileId,
        filename: job.filename,
        stage: job.stage,
        reason: job.error ?? `${job.stage} failed`,
        attempts: job.attempts,
        updatedAt: job.updatedAt,
      }));
    const searchableFiles = files.filter((file) => file.hasTranscript).length;
    const failedFiles = counts.failed;
    const pendingFiles = files.filter((file) => !file.hasTranscript && file.status !== "error").length;
    return {
      counts,
      percentProcessed: files.length === 0 ? 0 : (counts.done + counts.failed) / files.length,
      filesPerMinute: null,
      etaSeconds: null,
      activeFiles,
      pendingFileIds,
      failures,
      coverage: {
        totalFiles: files.length,
        searchableFiles,
        pendingFiles,
        failedFiles,
        producerNoteCount: 0,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  function retryMockFile(fileId: number): void {
    const file = MOCK_FILES.find((candidate) => candidate.id === fileId);
    if (!file) throw new Error(`Unknown file ${fileId}`);
    const failedJobs = MOCK_JOBS.filter((job) => job.fileId === fileId && job.status === "error");
    if (failedJobs.length === 0) return;
    const updatedAt = new Date().toISOString();
    for (const job of failedJobs) {
      job.status = "queued";
      job.attempts = 0;
      job.error = null;
      job.updatedAt = updatedAt;
    }
    if (file.status === "error") file.status = "processing";
  }

  return {
    // ---------- projects ----------

    async listProjects() {
      return projects;
    },

    async createProject(name: string) {
      const id =
        name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "") || `project-${projects.length + 1}`;
      const project: Project = {
        id,
        name: name.trim(),
        createdAt: new Date().toISOString(),
        lastOpenedAt: null,
      };
      projects.push(project);
      episodesByProject[id] = [];
      foldersByProject[id] = [];
      return project;
    },

    async openProject(id: string) {
      const project = projects.find((p) => p.id === id);
      if (!project) throw new Error(`Unknown project id: ${id}`);
      project.lastOpenedAt = new Date().toISOString();
      currentProjectId = id;
      notifyProjectUpdate();
      const state = buildProjectState();
      if (!state) throw new Error("Failed to open project");
      return state;
    },

    async getProjectState() {
      return buildProjectState();
    },

    // ---------- episodes & folders ----------

    async createEpisode(code: string) {
      if (!currentProjectId) throw new Error("No project open");
      const episode: Episode = {
        id: nextEpisodeId++,
        code: code.trim(),
        createdAt: new Date().toISOString(),
        membershipSource: "folder",
      };
      episodesByProject[currentProjectId] = [...(episodesByProject[currentProjectId] ?? []), episode];
      notifyProjectUpdate();
      return episode;
    },

    getEpisodeMembership,
    setEpisodeMembershipSource,
    replaceEpisodeClipList,

    async addProjectFolder(role: MediaRole, episodeId: number | null) {
      if (!currentProjectId) throw new Error("No project open");
      const path =
        role === "raw"
          ? `/Volumes/DAILIES_02/footage_incoming_${Date.now().toString().slice(-4)}`
          : `/Volumes/DAILIES_02/finals_incoming_${Date.now().toString().slice(-4)}`;
      const folder: ProjectFolder = {
        id: nextFolderId++,
        path,
        role,
        episodeId,
        lastScannedAt: null,
      };
      foldersByProject[currentProjectId] = [...(foldersByProject[currentProjectId] ?? []), folder];
      notifyProjectUpdate();
      return folder;
    },

    async removeProjectFolder(folderId: number) {
      if (!currentProjectId) return;
      foldersByProject[currentProjectId] = (foldersByProject[currentProjectId] ?? []).filter(
        (f) => f.id !== folderId,
      );
      notifyProjectUpdate();
    },

    async clearProjectCache() {
      notifyProjectUpdate();
      notifyIndexUpdate();
      return { clearedFiles: MOCK_FILES.length };
    },

    async rescanFolders(episodeId: number | null) {
      if (!currentProjectId) return;
      const now = new Date().toISOString();
      foldersByProject[currentProjectId] = (foldersByProject[currentProjectId] ?? []).map((f) =>
        episodeId === null || f.episodeId === episodeId ? { ...f, lastScannedAt: now } : f,
      );
      notifyProjectUpdate();
    },

    async importDocuments(_episodeId: number | null) {
      await new Promise((r) => setTimeout(r, 600));
      return 2;
    },

    // ---------- library ----------

    async listFiles(episodeId?: number) {
      if (episodeId === undefined) return MOCK_FILES;
      return MOCK_FILES.filter((file) => episodeMembers.get(episodeId)?.has(file.id));
    },

    async getFileDetail(fileId: number): Promise<FileDetail> {
      const detail = getFileDetail(fileId);
      if (!detail) throw new Error(`Unknown file id: ${fileId}`);
      return detail;
    },

    async getWords(_segmentId: number): Promise<WordTiming[]> {
      return [];
    },

    async listJobs() {
      return MOCK_JOBS;
    },

    async retryFile(fileId: number) {
      retryMockFile(fileId);
      notifyIndexUpdate();
    },

    // ---------- settings ----------

    async downloadWhisperModel(): Promise<void> {
      // Simulate a staged download, then flip the ready flag.
      let mb = 0;
      const total = 1624;
      const tick = () => {
        mb = Math.min(total, mb + 260);
        const done = mb >= total;
        if (done) {
          settings = { ...settings, whisperModelReady: true };
        }
        for (const cb of modelProgressListeners) {
          cb({ downloadedMb: mb, totalMb: total, pct: Math.round((mb / total) * 100), done, error: null });
        }
        if (!done) {
          setTimeout(tick, 450);
        }
      };
      setTimeout(tick, 400);
    },
    onModelProgress(cb: (p: ModelDownloadProgress) => void): () => void {
      modelProgressListeners.add(cb);
      return () => modelProgressListeners.delete(cb);
    },
    async getSettings() {
      return settings;
    },

    async setTelemetryEnabled(enabled: boolean) {
      settings = { ...settings, telemetryEnabled: enabled };
      return settings;
    },

    async setChatModel(modelId: string, effort?: string) {
      const selection = chatModelSelection(modelId, effort ?? settings.chatEffort);
      settings = { ...settings, chatModelId: selection.option.id, chatEffort: selection.effort };
      storeChatModel(settings.chatModelId, settings.chatEffort);
      return settings;
    },

    async exportDiagnostics() {
      return { kind: "written", path: "/mock/Dailies Exports/diagnostics.zip" } as const;
    },

    async setApiKey(_provider: "openrouter") {
      settings = { ...settings, apiKeySet: true, apiKeyStatus: "connected" };
      notifyIndexUpdate();
      return "connected" as const;
    },

    // ---------- chat ----------

    async listChats(scope?: ChatScope) {
      if (scope === undefined) return MOCK_CHATS;
      return MOCK_CHATS.filter((chat) => (chat.episodeId ?? null) === scope.episodeId);
    },

    async getChat(scopeOrChatId: ChatScope | number, maybeChatId?: number) {
      const chatId = typeof scopeOrChatId === "number" ? scopeOrChatId : maybeChatId;
      if (chatId === undefined) throw new Error("getChat requires a chat id with a scope");
      if (typeof scopeOrChatId !== "number") {
        const chat = MOCK_CHATS.find((candidate) => candidate.id === chatId);
        if (!chat || (chat.episodeId ?? null) !== scopeOrChatId.episodeId) return [];
      }
      return MOCK_CHAT_MESSAGES[chatId] ?? [];
    },

    async sendChatMessage(chatId: number | null, text: string, episodeId: number | null, turnId: string) {
      const existingChat = chatId !== null && MOCK_CHATS.some((chat) => chat.id === chatId);
      const id = existingChat ? chatId : nextChatId++;
      if (!existingChat) {
        MOCK_CHATS.unshift({ id, title: text.slice(0, 48), createdAt: new Date().toISOString(), episodeId });
      }
      const existing = MOCK_CHAT_MESSAGES[id] ?? [];
      const userMsg = {
        id: existing.length + 1,
        chatId: id,
        role: "user" as const,
        content: text,
        hits: null,
        createdAt: new Date().toISOString(),
      };
      MOCK_CHAT_MESSAGES[id] = [...existing, userMsg];

      // stage activity events over ~4s, then answer, then done
      let delay = 300;
      AGENT_STAGES.forEach((stage) => {
        delay += 550 + Math.random() * 250;
        setTimeout(() => emit({ type: "activity", chatId: id, turnId, agent: stage.agent, status: stage.status }), delay);
      });

      const answerDelay = delay + 500;
      setTimeout(() => {
        const answer = buildMockAnswer(text);
        const assistantMsg = {
          id: (MOCK_CHAT_MESSAGES[id]?.length ?? 0) + 1,
          chatId: id,
          role: "assistant" as const,
          content: answer.prose,
          hits: answer.hits,
          createdAt: new Date().toISOString(),
        };
        MOCK_CHAT_MESSAGES[id] = [...(MOCK_CHAT_MESSAGES[id] ?? []), assistantMsg];
        emit({ type: "answer", chatId: id, turnId, answer });
        setTimeout(() => emit({ type: "done", chatId: id, turnId }), 120);
      }, answerDelay);

      return { chatId: id };
    },

    onChatEvent(cb: Listener) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    // ---------- export ----------

    async exportHits(kind: ExportKind, items: ExportItem[]): Promise<ExportWriteOutcome> {
      await new Promise((r) => setTimeout(r, 400));
      if (items.length === 0) return { kind: "blocked", reason: "no-hits" };
      const fileIds = new Set(MOCK_FILES.map((file) => file.id));
      if (items.some((item) => !fileIds.has(item.fileId))) {
        return { kind: "blocked", reason: "no-valid-sources" };
      }
      const ext = kind === "edl" ? "edl" : "txt";
      return {
        kind: "written",
        result: {
          path: `/Users/editor/Desktop/dailies_export_${Date.now()}.${ext}`,
          kind,
          count: items.length,
        },
      };
    },

    async getPipelineSnapshot(scope: ChatScope) {
      return buildPipelineSnapshot(scope);
    },

    async getProjectActivities(): Promise<ProjectActivity[]> {
      const project = projects.find((candidate) => candidate.id === currentProjectId);
      if (!project) return [];
      const snapshot = buildPipelineSnapshot({ episodeId: null });
      return [{
        projectId: project.id,
        projectName: project.name,
        counts: snapshot.counts,
        activeFiles: snapshot.activeFiles,
      }];
    },

    async retryPipelineFailures(fileIds: number[]) {
      for (const fileId of fileIds) retryMockFile(fileId);
      notifyIndexUpdate();
      return buildPipelineSnapshot({ episodeId: null });
    },

    async exportPipelineFailures(scope: ChatScope) {
      const snapshot = buildPipelineSnapshot(scope);
      if (snapshot.failures.length === 0) return { kind: "blocked", reason: "no-failures" };
      return {
        kind: "written",
        path: `/Users/editor/Desktop/dailies_failures_${Date.now()}.csv`,
        count: snapshot.failures.length,
      };
    },

    async exportLocators(scope: ChatScope, items: ExportItem[]): Promise<LocatorExportOutcome> {
      const visibleFileIds = new Set(filesForScope(scope).map((file) => file.id));
      const validItems = items.filter((item) => visibleFileIds.has(item.fileId));
      if (validItems.length === 0) return { kind: "blocked", reason: "no-hits" };
      return {
        kind: "written",
        markerCount: validItems.length,
        clipCount: new Set(validItems.map((item) => item.fileId)).size,
        paths: [`/Users/editor/Desktop/dailies_locators_${Date.now()}`],
        revealPath: "/Users/editor/Desktop",
      };
    },

    async revealInFinder(_path: string) {
      // no-op in browser
    },

    async openExternal(url: string) {
      window.open(url, "_blank");
    },

    onProjectUpdate(cb: () => void) {
      projectUpdateListeners.add(cb);
      return () => projectUpdateListeners.delete(cb);
    },

    onIndexUpdate(cb: (update: IndexUpdate) => void) {
      indexUpdateListeners.add(cb);
      return () => indexUpdateListeners.delete(cb);
    },

    fileUrl(path: string) {
      return path;
    },

    // ---------- software update ----------

    async getUpdateState() {
      return updateState;
    },

    async checkForUpdates() {
      runMockCheck();
    },

    async restartToUpdate() {
      clearUpdateTimer();
      pushUpdateState({
        phase: "idle",
        availableVersion: undefined,
        transferred: undefined,
        total: undefined,
        lastCheckedAt: Date.now(),
      });
    },

    onUpdateStateChanged(cb: (s: UpdaterState) => void) {
      updateStateListeners.add(cb);
      return () => updateStateListeners.delete(cb);
    },
  };
}
