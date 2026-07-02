/**
 * Full in-browser mock of DailiesAPI so `vite dev` runs with no Electron.
 */
import type { DailiesAPI } from "../../shared/ipc";
import type { ChatEvent, ExportItem, ExportKind, ExportResult, FileDetail, WordTiming } from "../../shared/types";
import {
  AGENT_STAGES,
  buildMockAnswer,
  getFileDetail,
  MOCK_CHAT_MESSAGES,
  MOCK_CHATS,
  MOCK_FILES,
  MOCK_JOBS,
  MOCK_SETTINGS,
} from "./data";

type Listener = (ev: ChatEvent) => void;

export function createMockApi(): DailiesAPI {
  const listeners = new Set<Listener>();
  let nextChatId = MOCK_CHATS.length + 1;
  let settings = { ...MOCK_SETTINGS };

  function emit(ev: ChatEvent): void {
    listeners.forEach((cb) => cb(ev));
  }

  return {
    async listFiles() {
      return MOCK_FILES;
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

    async addWatchedFolder() {
      const path = "/Volumes/DAILIES_02/footage_incoming";
      if (!settings.watchedFolders.includes(path)) {
        settings = { ...settings, watchedFolders: [...settings.watchedFolders, path] };
      }
      return path;
    },

    async removeWatchedFolder(path: string) {
      settings = { ...settings, watchedFolders: settings.watchedFolders.filter((p) => p !== path) };
    },

    async getSettings() {
      return settings;
    },

    async setApiKey(provider: "anthropic" | "gemini") {
      settings = {
        ...settings,
        anthropicKeySet: provider === "anthropic" ? true : settings.anthropicKeySet,
        geminiKeySet: provider === "gemini" ? true : settings.geminiKeySet,
      };
      return true;
    },

    async setQualityMode(mode) {
      settings = { ...settings, qualityMode: mode };
    },

    async listChats() {
      return MOCK_CHATS;
    },

    async getChat(chatId: number) {
      return MOCK_CHAT_MESSAGES[chatId] ?? [];
    },

    async sendChatMessage(chatId: number | null, text: string) {
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

    fileUrl(path: string) {
      return path;
    },
  };
}
