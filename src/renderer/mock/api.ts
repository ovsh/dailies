/**
 * Full in-browser mock of DailiesAPI so `vite dev` runs with no Electron.
 */
import type { DailiesAPI } from "../../shared/ipc";
import type {
  ChatEvent,
  Episode,
  ExportItem,
  ExportKind,
  ExportResult,
  FileDetail,
  MediaRole,
  Project,
  ProjectFolder,
  ProjectState,
  WordTiming,
} from "../../shared/types";
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
  MOCK_PROJECTS,
  MOCK_SETTINGS,
} from "./data";

type Listener = (ev: ChatEvent) => void;

export function createMockApi(): DailiesAPI {
  const listeners = new Set<Listener>();
  const projectUpdateListeners = new Set<() => void>();
  let nextChatId = MOCK_CHATS.length + 1;
  let settings = { ...MOCK_SETTINGS };

  // Mutable in-memory copies so add/remove/rescan/create operations persist for the session.
  const projects: Project[] = MOCK_PROJECTS.map((p) => ({ ...p }));
  const episodesByProject: Record<string, Episode[]> = Object.fromEntries(
    Object.entries(MOCK_EPISODES).map(([id, eps]) => [id, eps.map((e) => ({ ...e }))]),
  );
  const foldersByProject: Record<string, ProjectFolder[]> = Object.fromEntries(
    Object.entries(MOCK_FOLDERS).map(([id, folders]) => [id, folders.map((f) => ({ ...f }))]),
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
      };
      episodesByProject[currentProjectId] = [...(episodesByProject[currentProjectId] ?? []), episode];
      notifyProjectUpdate();
      return episode;
    },

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
      return MOCK_FILES.filter((f) => f.episodeId === episodeId);
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

    // ---------- settings ----------

    async getSettings() {
      return settings;
    },

    async setApiKey(_provider: "gemini") {
      settings = { ...settings, geminiKeySet: true };
      return true;
    },

    async setQualityMode(mode) {
      settings = { ...settings, qualityMode: mode };
    },

    // ---------- chat ----------

    async listChats() {
      return MOCK_CHATS;
    },

    async getChat(chatId: number) {
      return MOCK_CHAT_MESSAGES[chatId] ?? [];
    },

    async sendChatMessage(chatId: number | null, text: string, _episodeId: number | null) {
      const id = chatId ?? nextChatId++;
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
        setTimeout(() => emit({ type: "activity", chatId: id, agent: stage.agent, status: stage.status }), delay);
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
        emit({ type: "answer", chatId: id, answer });
        setTimeout(() => emit({ type: "done", chatId: id }), 120);
      }, answerDelay);

      return { chatId: id };
    },

    onChatEvent(cb: Listener) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    // ---------- export ----------

    async exportHits(kind: ExportKind, items: ExportItem[]): Promise<ExportResult> {
      await new Promise((r) => setTimeout(r, 400));
      const ext = kind === "edl" ? "edl" : "txt";
      return {
        path: `/Users/editor/Desktop/dailies_export_${Date.now()}.${ext}`,
        kind,
        count: items.length,
      };
    },

    async revealInFinder(_path: string) {
      // no-op in browser
    },

    onProjectUpdate(cb: () => void) {
      projectUpdateListeners.add(cb);
      return () => projectUpdateListeners.delete(cb);
    },

    fileUrl(path: string) {
      return path;
    },
  };
}
