import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, mediaUrl } from "../api";
import { CHAT_MODEL_OPTIONS, DEFAULT_CHAT_MODEL_ID } from "../../shared/types";
import type {
  AgentAnswer,
  AnswerHit,
  ChatMessageRecord,
  ChatSummary,
  Episode,
  EpisodeMembershipReport,
  ExportItem,
  FileDetail,
  LocatorExportOutcome,
  MediaFile,
  PipelineSnapshot,
  SearchCoverage,
  StructuredAgentAnswer,
} from "../../shared/types";
import { ActivityLine } from "../components/ActivityLine";
import { EpisodeBar } from "../components/EpisodeBar";
import { HitCard } from "../components/HitCard";
import { Toast } from "../components/Toast";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { runIpc } from "../lib/async";
import { isAudioOnly } from "../lib/media";

interface ChatScreenProps {
  /** Preview's one hop out: switches to Library with the source card focused. */
  onOpenInLibrary: (fileId: number) => void;
  /** null while settings are loading; false shows the setup hint. */
  apiKeySet?: boolean | null;
  onOpenSettings?: () => void;
  /** Current episode scope; null = whole project. */
  episodeId: number | null;
  episodes: Episode[];
  onEpisodeChange: (id: number | null) => void;
  onCreateEpisode: (code: string) => Promise<void>;
}

/** Inline hit preview: Play loads detail, opens the pop-over, seeks, and plays — never navigates. */
interface PreviewTarget {
  hit: AnswerHit;
  fileDetail: FileDetail;
  returnFocusId: string;
}

function hitIdentity(hit: AnswerHit, index: number): string {
  return `${hit.fileId}-${hit.segmentId ?? `legacy-${index}`}-${hit.inS}`;
}

interface ActivityEvent {
  agent: string;
  status: string;
}

interface Turn {
  id: string;
  question: string;
  activity: ActivityEvent[];
  answer: AgentAnswer | StructuredAgentAnswer | null;
  error: string | null;
  pending: boolean;
}

interface ToastState {
  message: string;
  action?: { label: string; onClick: () => void };
}

/**
 * What a turn actually renders. Live and v2 historical turns arrive as
 * StructuredAgentAnswer. Bare hit arrays remain the legacy history shape.
 */
type DisplayAnswer =
  | { kind: "message"; text: string }
  | { kind: "empty"; coverage: SearchCoverage }
  | { kind: "results"; summary: string | null; hits: AnswerHit[] }
  | { kind: "legacy-visual"; prose: string; hits: AnswerHit[] };

function toDisplayAnswer(answer: AgentAnswer | StructuredAgentAnswer): DisplayAnswer {
  if ("kind" in answer) {
    if (answer.kind === "results") return { kind: "results", summary: answer.summary, hits: answer.hits };
    return answer;
  }
  if (answer.hits.some((hit) => hit.kind === "visual")) {
    return { kind: "legacy-visual", prose: answer.prose, hits: answer.hits };
  }
  if (answer.hits.length === 0) return { kind: "message", text: answer.prose };
  return { kind: "results", summary: answer.prose.length > 0 ? answer.prose : null, hits: answer.hits };
}

/** Collapses a quote/description to one line for the copy contract below. */
export function normalizeCopyLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The one true copy format: `"line" · clip · timecode`, straight quotes, middle dots. */
export function formatHitCopyLine(hit: AnswerHit): string {
  const line = normalizeCopyLine(hit.quote ?? hit.description ?? "");
  return `"${line}" · ${hit.filename} · ${hit.inTc}`;
}

export function formatHitsCopyAll(hits: AnswerHit[]): string {
  return hits.map(formatHitCopyLine).join("\n");
}

const CONFIDENCE_DOT_COLOR: Record<AnswerHit["confidence"], string> = {
  high: "var(--status-ok)",
  medium: "var(--status-warn)",
  low: "var(--ink-faint)",
};


/** Honest explanation for a null playbackPath — never a silent dead player. */
function unplayableReason(file: MediaFile): string {
  return file.videoUnplayable
    ? "No preview — proxy failed. Retry the file in Jobs."
    : "No preview — this format can't be played in-app. Retry the file in Jobs.";
}

function formatChatDate(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.toLocaleString("en-US", { day: "2-digit", month: "short" })}${year}`.toUpperCase();
}

/** The chip on a rail row: the chat's own bound scope, not the active scope. */
function chatChipLabel(chat: ChatSummary, episodes: Episode[]): string {
  const boundEpisodeId = chat.episodeId ?? null;
  if (boundEpisodeId === null) return "ALL";
  return episodes.find((e) => e.id === boundEpisodeId)?.code ?? "ALL";
}

// ---------- chat-history rail width ----------

const CHAT_HISTORY_WIDTH_KEY = "dailies.chatHistoryWidth";
const CHAT_HISTORY_WIDTH_DEFAULT = 216;
const CHAT_HISTORY_WIDTH_MIN = 160;
const CHAT_HISTORY_WIDTH_MAX = 420;

function clampHistoryWidth(width: number): number {
  return Math.min(CHAT_HISTORY_WIDTH_MAX, Math.max(CHAT_HISTORY_WIDTH_MIN, Math.round(width)));
}

function loadHistoryWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(CHAT_HISTORY_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampHistoryWidth(stored);
  } catch {
    // storage unavailable; fall through to the default
  }
  return CHAT_HISTORY_WIDTH_DEFAULT;
}

function saveHistoryWidth(width: number): void {
  try {
    window.localStorage.setItem(CHAT_HISTORY_WIDTH_KEY, String(width));
  } catch {
    // storage unavailable; the width just won't persist
  }
}

function messagesToTurns(messages: ChatMessageRecord[]): Turn[] {
  const historicalTurns: Turn[] = [];
  let current: Turn | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      current = {
        id: `history-${message.id}`,
        question: message.content,
        activity: [],
        answer: null,
        error: null,
        pending: false,
      };
      historicalTurns.push(current);
    } else if (current && current.answer === null) {
      current.answer = message.answer ?? { prose: message.content, hits: message.hits ?? [] };
    }
  }

  return historicalTurns;
}

export function ChatScreen({
  onOpenInLibrary,
  apiKeySet,
  onOpenSettings,
  episodeId,
  episodes,
  onEpisodeChange,
  onCreateEpisode,
}: ChatScreenProps) {
  const [chatId, setChatId] = useState<number | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [chatModelId, setChatModelId] = useState(DEFAULT_CHAT_MODEL_ID);

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => setChatModelId(settings.chatModelId))
      .catch(() => {
        /* keep the default; the selector still works */
      });
  }, []);

  const handleModelChange = (modelId: string) => {
    const previous = chatModelId;
    setChatModelId(modelId);
    api.setChatModel(modelId).catch(() => setChatModelId(previous));
  };
  const [toast, setToast] = useState<ToastState | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<PipelineSnapshot["coverage"] | null>(null);
  const [membership, setMembership] = useState<EpisodeMembershipReport | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [previewPendingHit, setPreviewPendingHit] = useState<AnswerHit | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTcCopied, setPreviewTcCopied] = useState(false);
  /** Files a real load attempt found has no playable path — disables their row's play button from then on. */
  const [unplayableFiles, setUnplayableFiles] = useState<Map<number, string>>(new Map());
  const [historyWidth, setHistoryWidth] = useState(loadHistoryWidth);
  const [historyResizing, setHistoryResizing] = useState(false);
  const historyResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnCounterRef = useRef(0);
  const runningTurnIdRef = useRef<string | null>(null);
  const historyGenerationRef = useRef(0);
  const previewGenerationRef = useRef(0);
  const previewReturnFocusRef = useRef<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  const previewCloseBtnRef = useRef<HTMLButtonElement>(null);
  const previewCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const previewOpen = preview !== null || previewPendingHit !== null || previewError !== null;

  const openPreview = useCallback(async (hit: AnswerHit, returnFocusId: string) => {
    const generation = ++previewGenerationRef.current;
    previewReturnFocusRef.current = returnFocusId;
    setPreview(null);
    setPreviewError(null);
    setPreviewTcCopied(false);
    setPreviewPendingHit(hit);
    try {
      const fileDetail = await api.getFileDetail(hit.fileId);
      if (generation !== previewGenerationRef.current) return;
      setPreviewPendingHit(null);
      setPreview({ hit, fileDetail, returnFocusId });
      if (fileDetail.playbackPath === null) {
        const reason = unplayableReason(fileDetail.file);
        setUnplayableFiles((prev) => (prev.get(hit.fileId) === reason ? prev : new Map(prev).set(hit.fileId, reason)));
      }
    } catch {
      if (generation !== previewGenerationRef.current) return;
      setPreviewPendingHit(null);
      setPreviewError("Could not load this clip.");
    }
  }, []);

  const closePreview = useCallback(() => {
    previewGenerationRef.current += 1;
    if (previewCopyTimerRef.current) clearTimeout(previewCopyTimerRef.current);
    const video = previewVideoRef.current;
    const audio = previewAudioRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    const returnFocusId = previewReturnFocusRef.current;
    setPreview(null);
    setPreviewPendingHit(null);
    setPreviewError(null);
    setPreviewTcCopied(false);
    if (returnFocusId) {
      requestAnimationFrame(() => document.getElementById(returnFocusId)?.focus());
    }
  }, []);

  function copyPreviewTc(tc: string) {
    void navigator.clipboard.writeText(tc);
    setPreviewTcCopied(true);
    if (previewCopyTimerRef.current) clearTimeout(previewCopyTimerRef.current);
    previewCopyTimerRef.current = setTimeout(() => setPreviewTcCopied(false), 1000);
  }

  useEffect(() => {
    return () => {
      if (previewCopyTimerRef.current) clearTimeout(previewCopyTimerRef.current);
    };
  }, []);

  // Focus lands in the pop-over the instant it opens, even while the file
  // detail is still loading — the close button is the one stable target.
  useEffect(() => {
    if (previewOpen) previewCloseBtnRef.current?.focus();
  }, [previewOpen]);

  useEffect(() => {
    if (!previewOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closePreview();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewOpen, closePreview]);

  const refreshChats = useCallback(async () => {
    setChatsLoading(true);
    try {
      setChats(await api.listChats({ episodeId }));
      setHistoryError(null);
    } catch {
      setHistoryError("Could not load conversations.");
    } finally {
      setChatsLoading(false);
    }
  }, [episodeId]);

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  // A retry in Jobs can heal a file between refreshes, so a "no preview"
  // verdict is only trusted until the next index update.
  const refreshPlayability = useCallback(async () => {
    setUnplayableFiles((prev) => (prev.size === 0 ? prev : new Map()));
  }, []);

  useLiveRefresh(refreshPlayability);

  const refreshCoverage = useCallback(async () => {
    const result = await runIpc(() => api.getPipelineSnapshot({ episodeId }), {
      setError: () => {
        // Non-critical banner data; a failed fetch just leaves it hidden.
      },
      fallback: "Could not load indexing coverage.",
    });
    if (result.ok) setCoverage(result.value.coverage);
  }, [episodeId]);

  useEffect(() => {
    void refreshCoverage();
  }, [refreshCoverage]);

  useLiveRefresh(refreshCoverage);

  const refreshMembership = useCallback(async () => {
    if (episodeId === null) {
      setMembership(null);
      return;
    }
    const result = await runIpc(() => api.getEpisodeMembership(episodeId), {
      setError: () => {
        // Non-critical banner data; a failed fetch just leaves it hidden.
      },
      fallback: "Could not load episode membership.",
    });
    if (result.ok) setMembership(result.value);
  }, [episodeId]);

  useEffect(() => {
    void refreshMembership();
  }, [refreshMembership]);

  useLiveRefresh(refreshMembership);

  // Scope changed: the rail is about to reload for the new episode. Drop the
  // visible conversation now rather than let a stale one linger, and release
  // the send lock — a turn already running keeps running in its own scope
  // (see onChatEvent below, which only updates a turn still present in
  // `turns`), it is just no longer the one on screen.
  const previousEpisodeIdRef = useRef(episodeId);
  useEffect(() => {
    if (previousEpisodeIdRef.current === episodeId) return;
    previousEpisodeIdRef.current = episodeId;
    historyGenerationRef.current += 1;
    runningTurnIdRef.current = null;
    setChatId(null);
    setTurns([]);
    setInput("");
    setHistoryError(null);
    setConversationLoading(false);
    closePreview();
  }, [episodeId, closePreview]);

  useEffect(() => {
    const unsubscribe = api.onChatEvent((ev) => {
      const turnId = ev.turnId;
      if (ev.type === "activity") {
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, activity: [...t.activity, { agent: ev.agent, status: ev.status }] } : t)),
        );
      } else if (ev.type === "answer") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, answer: ev.answer } : t)));
      } else if (ev.type === "error") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: ev.message, pending: false } : t)));
        if (runningTurnIdRef.current === turnId) runningTurnIdRef.current = null;
      } else if (ev.type === "done") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, pending: false } : t)));
        if (runningTurnIdRef.current === turnId) runningTurnIdRef.current = null;
        void refreshChats();
      }
    });
    return unsubscribe;
  }, [refreshChats]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function handleSend() {
    const text = input.trim();
    if (!text || runningTurnIdRef.current !== null) return;
    setInput("");

    const turnId = `${Date.now()}-${++turnCounterRef.current}`;
    runningTurnIdRef.current = turnId;
    setTurns((prev) => [...prev, { id: turnId, question: text, activity: [], answer: null, error: null, pending: true }]);

    try {
      const res = await api.sendChatMessage(chatId, text, episodeId, turnId);
      setChatId(res.chatId);
      void refreshChats();
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, pending: false, error: err instanceof Error ? err.message : "Something went wrong." } : t)),
      );
      if (runningTurnIdRef.current === turnId) runningTurnIdRef.current = null;
    }
  }

  async function handleSelectChat(selectedChatId: number) {
    if (runningTurnIdRef.current !== null || selectedChatId === chatId) return;
    const generation = ++historyGenerationRef.current;
    closePreview();
    setChatId(selectedChatId);
    setTurns([]);
    setConversationLoading(true);
    setHistoryError(null);
    try {
      const messages = await api.getChat({ episodeId }, selectedChatId);
      if (generation === historyGenerationRef.current) setTurns(messagesToTurns(messages));
    } catch {
      if (generation === historyGenerationRef.current) setHistoryError("Could not open that conversation.");
    } finally {
      if (generation === historyGenerationRef.current) setConversationLoading(false);
    }
  }

  function handleNewChat() {
    if (runningTurnIdRef.current !== null) return;
    historyGenerationRef.current += 1;
    closePreview();
    setChatId(null);
    setTurns([]);
    setInput("");
    setHistoryError(null);
    setConversationLoading(false);
  }

  function handleHistoryResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    historyResizeRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: historyWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    setHistoryResizing(true);
  }

  function handleHistoryResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = historyResizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setHistoryWidth(clampHistoryWidth(drag.startWidth + (e.clientX - drag.startX)));
  }

  function handleHistoryResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    const drag = historyResizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    historyResizeRef.current = null;
    setHistoryResizing(false);
    setHistoryWidth((w) => {
      saveHistoryWidth(w);
      return w;
    });
  }

  function handleHistoryResizeKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampHistoryWidth(historyWidth + (e.key === "ArrowRight" ? 16 : -16));
    setHistoryWidth(next);
    saveHistoryWidth(next);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  /** Board A/C export contract: scoped, validated by main, never a silent drop. */
  async function handleExportLocators(hits: AnswerHit[]): Promise<LocatorExportOutcome> {
    const items: ExportItem[] = hits.map((h) => ({
      fileId: h.fileId,
      inTc: h.inTc,
      outTc: h.outTc,
      inS: h.inS,
      outS: h.outS,
      comment: formatHitCopyLine(h),
      color: h.confidence === "high" ? "green" : h.confidence === "medium" ? "yellow" : undefined,
    }));
    return api.exportLocators({ episodeId }, items);
  }

  function showLocatorExportToast(outcome: Extract<LocatorExportOutcome, { kind: "written" }>) {
    setToast({
      message: `Exported ${outcome.markerCount} ${outcome.markerCount === 1 ? "marker" : "markers"} · ${outcome.clipCount} ${outcome.clipCount === 1 ? "clip" : "clips"}`,
      action: { label: "Reveal in Finder", onClick: () => api.revealInFinder(outcome.revealPath) },
    });
  }

  /** Unscoped, pre-Phase-11 export path — kept only for legacy visual-hit history. */
  async function handleLegacyExport(hits: AnswerHit[]) {
    const items: ExportItem[] = hits.map((h) => ({
      fileId: h.fileId,
      inTc: h.inTc,
      outTc: h.outTc,
      inS: h.inS,
      outS: h.outS,
      comment: formatHitCopyLine(h),
      color: h.confidence === "high" ? "green" : h.confidence === "medium" ? "yellow" : undefined,
    }));
    const outcome = await api.exportHits("locators", items);
    if (outcome.kind === "blocked") {
      setToast({
        message: outcome.reason === "no-hits"
          ? "Export stopped · no markers in this answer"
          : "Export stopped · one or more source files are no longer available",
      });
      return;
    }
    const result = outcome.result;
    setToast({
      message: `Exported ${result.count} ${result.count === 1 ? "marker" : "markers"} · ${result.path.split("/").pop()}`,
      action: { label: "Reveal in Finder", onClick: () => api.revealInFinder(result.path) },
    });
  }

  const isEmpty = turns.length === 0;
  const isAnswering = turns.some((turn) => turn.pending);
  const activeEpisode = episodeId === null ? null : episodes.find((e) => e.id === episodeId) ?? null;
  const scopeLabel = activeEpisode ? `Episode ${activeEpisode.code}` : "All Episodes";
  const chatCountLabel = `${chats.length} ${chats.length === 1 ? "chat" : "chats"}`;
  const partialCoverage =
    coverage !== null && coverage.totalFiles > 0 && coverage.pendingFiles + coverage.failedFiles > 0;
  const coverageBannerText = coverage
    ? coverage.pendingFiles > 0
      ? `INDEXING · ${coverage.pendingFiles} OF ${coverage.totalFiles} FILES REMAIN · ANSWERS COVER INDEXED FILES ONLY`
      : `${coverage.failedFiles} ${coverage.failedFiles === 1 ? "FILE" : "FILES"} NOT SEARCHABLE · ANSWERS COVER INDEXED FILES ONLY`
    : "";
  const membershipUnresolvedCount =
    membership && membership.source === "list" ? membership.ambiguousCount + membership.unmatchedCount : 0;
  const membershipBannerText =
    membershipUnresolvedCount > 0 && membership
      ? `CLIP LIST · ${membership.ambiguousCount} AMBIGUOUS · ${membership.unmatchedCount} NOT FOUND · ANSWERS COVER MATCHED CLIPS ONLY`
      : "";
  const activePreviewHit = preview?.hit ?? previewPendingHit ?? null;
  const activePreviewKey = activePreviewHit ? previewReturnFocusRef.current : null;

  return (
    <div className="chat-screen">
      <aside className="chat-history" aria-label="Conversations in this scope" style={{ flexBasis: historyWidth }}>
        <div className="chat-history-head">
          <span className="label">{scopeLabel} · {chatCountLabel}</span>
          <button className="chat-new label" onClick={handleNewChat} disabled={isAnswering}>
            New chat
          </button>
        </div>
        <div className="chat-history-list">
          {chats.map((chat) => (
            <button
              key={chat.id}
              className={`chat-history-item${chat.id === chatId ? " active" : ""}`}
              onClick={() => void handleSelectChat(chat.id)}
              disabled={isAnswering}
              aria-current={chat.id === chatId ? "page" : undefined}
            >
              <span className="chat-history-title">{chat.title}</span>
              <span className="chat-history-meta">
                <span className="chat-history-chip mono">{chatChipLabel(chat, episodes)}</span>
                <span className="chat-history-date mono">{formatChatDate(chat.createdAt)}</span>
              </span>
            </button>
          ))}
          {chatsLoading && chats.length === 0 && <span className="chat-history-note mono">Loading…</span>}
          {!chatsLoading && chats.length === 0 && !historyError && (
            <span className="chat-history-note mono">No chats in this scope yet.</span>
          )}
          {historyError && <span className="chat-history-note error mono">{historyError}</span>}
        </div>
        <div
          className={`chat-history-resize${historyResizing ? " dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation list"
          aria-valuenow={historyWidth}
          aria-valuemin={CHAT_HISTORY_WIDTH_MIN}
          aria-valuemax={CHAT_HISTORY_WIDTH_MAX}
          tabIndex={0}
          onPointerDown={handleHistoryResizeStart}
          onPointerMove={handleHistoryResizeMove}
          onPointerUp={handleHistoryResizeEnd}
          onPointerCancel={handleHistoryResizeEnd}
          onKeyDown={handleHistoryResizeKeyDown}
        />
      </aside>

      <div className="chat-main">
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-column">
            <div className="chat-episode-bar">
              <EpisodeBar
                episodes={episodes}
                activeEpisodeId={episodeId}
                onSelect={onEpisodeChange}
                onCreate={onCreateEpisode}
                size="centered"
              />
            </div>

            {partialCoverage &&
              (onOpenSettings ? (
                <button type="button" className="coverage-banner mono" onClick={onOpenSettings}>
                  {coverageBannerText}
                </button>
              ) : (
                <div className="coverage-banner mono">{coverageBannerText}</div>
              ))}

            {membershipUnresolvedCount > 0 &&
              (onOpenSettings ? (
                <button type="button" className="coverage-banner mono" onClick={onOpenSettings}>
                  {membershipBannerText}
                </button>
              ) : (
                <div className="coverage-banner mono">{membershipBannerText}</div>
              ))}

            {conversationLoading && <p className="chat-conversation-loading mono">Loading conversation…</p>}

            {isEmpty && !conversationLoading && (
              <div className="chat-empty">
                <p className="display chat-empty-line">Ask your footage anything.</p>
                <p className="chat-empty-sub">
                  Search transcripts and producer notes, like "where does Marsh mention the salmon run?"
                </p>
                {activeEpisode && <p className="chat-empty-scope mono">Searching episode {activeEpisode.code}</p>}
                {apiKeySet === false && onOpenSettings && (
                  <button className="chat-key-hint" onClick={onOpenSettings}>
                    No OpenRouter key yet. Set one up in Settings →
                  </button>
                )}
              </div>
            )}

            {turns.map((turn) => (
              <div key={turn.id} className="turn">
                <div className="turn-question">
                  <span className="label turn-question-label">You</span>
                  <p>{turn.question}</p>
                </div>

                {(turn.pending || turn.activity.length > 0) && !turn.answer && (
                  <div className="turn-activity">
                    {turn.activity.map((a, i) => (
                      <ActivityLine key={i} agent={a.agent} status={a.status} index={i} />
                    ))}
                    {turn.pending && <span className="turn-cursor mono">▌</span>}
                  </div>
                )}

                {turn.error && <p className="turn-error mono">{turn.error}</p>}

                {turn.answer && (
                  <TurnAnswer
                    answer={toDisplayAnswer(turn.answer)}
                    onPlay={(hit, returnFocusId) => void openPreview(hit, returnFocusId)}
                    activePreviewKey={activePreviewKey}
                    unplayableFiles={unplayableFiles}
                    onExportLocators={handleExportLocators}
                    onExportSuccess={showLocatorExportToast}
                    onLegacyExport={(hits) => void handleLegacyExport(hits)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="chat-input-bar">
          <div className="chat-column">
            <div className="chat-input-wrap">
              <textarea
                className="chat-input"
                placeholder="Ask about your footage…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
              />
              <button className="chat-send" onClick={handleSend} disabled={!input.trim() || isAnswering}>
                {isAnswering ? "Answering…" : "Send"}
              </button>
            </div>
            <div className="chat-input-hint mono">
              <label className="chat-model-label" htmlFor="chat-model-select">
                Model
              </label>
              <select
                id="chat-model-select"
                className="chat-model-select mono"
                value={chatModelId}
                onChange={(e) => handleModelChange(e.target.value)}
              >
                {CHAT_MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span>· ⌘⏎ to send</span>
            </div>
          </div>
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.action?.label}
          onAction={toast.action?.onClick}
          onDismiss={() => setToast(null)}
        />
      )}

      {previewOpen && (
        <>
          <div className="preview-scrim" onClick={closePreview} />
          <div className="preview-pop" role="dialog" aria-modal="true" aria-label="Clip preview">
            <div className="preview-pop-head">
              <span className="label">Preview</span>
              <button ref={previewCloseBtnRef} className="preview-pop-close" onClick={closePreview} aria-label="Close preview">
                ✕
              </button>
            </div>
            <div className="preview-pop-body">
              {previewPendingHit && <p className="preview-pop-loading mono">Loading…</p>}
              {previewError && <p className="preview-pop-error mono">{previewError}</p>}
              {preview && (
                <>
                  <div className="preview-bezel">
                    {!preview.fileDetail.playbackPath ? (
                      <div className="preview-unavailable mono">
                        {unplayableReason(preview.fileDetail.file)}
                      </div>
                    ) : isAudioOnly(preview.fileDetail.file) ? (
                      <div className="preview-audio-wrap">
                        {preview.fileDetail.file.videoUnplayable && (
                          <span className="preview-audio-label label">Audio only — proxy failed</span>
                        )}
                        <audio
                          ref={previewAudioRef}
                          className="preview-audio"
                          src={mediaUrl(preview.fileDetail.playbackPath)}
                          controls
                          aria-label={`Play ${preview.hit.filename}`}
                          onLoadedMetadata={(e) => {
                            e.currentTarget.currentTime = preview.hit.inS;
                            void e.currentTarget.play();
                          }}
                          onError={() => setPreviewError("This clip could not be played back.")}
                        />
                      </div>
                    ) : (
                      <video
                        ref={previewVideoRef}
                        className="preview-video"
                        src={mediaUrl(preview.fileDetail.playbackPath)}
                        controls
                        aria-label={`Play ${preview.hit.filename}`}
                        onLoadedMetadata={(e) => {
                          e.currentTarget.currentTime = preview.hit.inS;
                          void e.currentTarget.play();
                        }}
                        onError={() => setPreviewError("This clip could not be played back.")}
                      />
                    )}
                  </div>
                  <div className="preview-meta">
                    <span className="preview-meta-row">
                      <span>CLIP</span>
                      <span className="mono">{preview.hit.filename}</span>
                    </span>
                    <span className="preview-meta-row">
                      <span>PLAYS FROM</span>
                      <span className="mono">{preview.hit.inTc}</span>
                    </span>
                  </div>
                  <div className="preview-actions">
                    <button className="ghost-btn label" onClick={() => copyPreviewTc(preview.hit.inTc)}>
                      {previewTcCopied ? "Copied" : "Copy TC"}
                    </button>
                    <button className="ghost-btn label" onClick={() => onOpenInLibrary(preview.hit.fileId)}>
                      Open in library
                    </button>
                    {!preview.fileDetail.playbackPath && onOpenSettings && (
                      <button className="ghost-btn label" onClick={onOpenSettings}>
                        Retry in Jobs
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      <style>{`
        .chat-screen {
          height: 100%;
          display: flex;
          min-width: 0;
        }
        .chat-history {
          flex: 0 0 auto;
          position: relative;
          min-width: 0;
          padding: 50px 10px 14px;
          border-right: 1px solid var(--panel-border);
          background: var(--ground-raised);
          box-shadow: var(--bevel-out);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .chat-history-resize {
          position: absolute;
          top: 0;
          right: -4px;
          width: 8px;
          height: 100%;
          cursor: col-resize;
          z-index: 5;
          background: transparent;
          touch-action: none;
        }
        .chat-history-resize::after {
          content: "";
          position: absolute;
          top: 0;
          left: 3px;
          width: 2px;
          height: 100%;
          background: transparent;
          transition: background var(--dur-fast, 120ms) ease;
        }
        .chat-history-resize:hover::after,
        .chat-history-resize.dragging::after,
        .chat-history-resize:focus-visible::after {
          background: var(--accent);
        }
        .chat-history-resize:focus {
          outline: none;
        }
        .chat-history-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0 4px 10px;
          box-shadow: inset 0 -1px 0 var(--chrome-lo);
          flex: 0 0 auto;
        }
        .chat-history-head .label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .chat-new {
          flex: 0 0 auto;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: var(--ink);
          padding: 5px 9px;
          font-size: 9.5px;
          white-space: nowrap;
        }
        .chat-new:hover:not(:disabled) {
          background: #d2d6d9;
        }
        .chat-new:active:not(:disabled) {
          box-shadow: var(--bevel-in);
        }
        .chat-new:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
        .chat-history-list {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1px;
          margin-top: 8px;
          padding: 4px;
          background: var(--ground-card);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          overflow-y: auto;
        }
        .chat-history-item {
          width: 100%;
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 3px;
          border: none;
          border-radius: 0;
          background: transparent;
          color: var(--ink-dim);
          padding: 7px 6px;
        }
        .chat-history-item:hover:not(:disabled):not(.active) {
          background: var(--paper-alt);
        }
        .chat-history-item.active {
          background: var(--select-bg);
          color: var(--select-ink);
        }
        .chat-history-item:disabled {
          cursor: default;
        }
        .chat-history-title {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: inherit;
          font-size: 11.5px;
        }
        .chat-history-meta {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .chat-history-chip {
          border: 1px solid currentColor;
          border-radius: 2px;
          padding: 0 4px;
          font-size: 9px;
          color: var(--ink-dimmer);
        }
        .chat-history-date {
          color: var(--ink-dimmer);
          font-size: 9px;
        }
        .chat-history-item.active .chat-history-chip,
        .chat-history-item.active .chat-history-date {
          color: var(--select-ink);
          opacity: 0.7;
        }
        .chat-history-note {
          padding: 8px 6px;
          color: var(--ink-faint);
          font-size: 9.5px;
          line-height: 1.5;
        }
        .chat-history-note.error {
          color: var(--status-error);
        }
        .chat-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          background: var(--ground-card);
        }
        .chat-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 56px 40px 24px;
        }
        .chat-column {
          max-width: 680px;
          margin: 0 auto;
        }
        .chat-episode-bar {
          display: flex;
          justify-content: center;
          padding-top: 4px;
        }
        .coverage-banner {
          display: flex;
          width: 100%;
          align-items: center;
          gap: 8px;
          margin: 16px 0 0;
          padding: 8px 10px;
          background: #f4ecd2;
          border: 1px solid var(--status-warn);
          color: var(--status-warn);
          border-radius: 2px;
          font-size: 10.5px;
          text-align: left;
          letter-spacing: 0.02em;
        }
        button.coverage-banner {
          cursor: pointer;
        }
        button.coverage-banner:hover {
          filter: brightness(0.97);
        }
        .chat-empty {
          padding-top: 14vh;
          text-align: center;
        }
        .chat-conversation-loading {
          padding-top: 14vh;
          text-align: center;
          color: var(--ink-dimmer);
          font-size: 10.5px;
        }
        .chat-empty-line {
          font-size: 34px;
          color: var(--ink);
          margin: 0 0 14px;
        }
        .chat-empty-sub {
          font-size: 13.5px;
          color: var(--ink-dim);
          max-width: 440px;
          margin: 0 auto;
          line-height: 1.6;
        }
        .chat-empty-scope {
          margin: 18px 0 0;
          font-size: 11px;
          color: var(--ink-dim);
        }
        .chat-key-hint {
          margin-top: 26px;
          background: var(--ground-card);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          padding: 9px 16px;
          font-size: 12px;
          color: var(--accent);
        }
        .chat-key-hint:hover {
          border-color: var(--accent-dim);
          background: var(--accent-wash);
        }
        .turn {
          margin-bottom: 48px;
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .turn-question {
          margin-bottom: 20px;
        }
        .turn-question-label {
          display: block;
          margin-bottom: 6px;
        }
        .turn-question p {
          font-size: 16px;
          color: var(--ink);
          margin: 0;
          line-height: 1.5;
        }
        .turn-activity {
          padding: 4px 0 8px;
          display: flex;
          flex-direction: column;
        }
        .turn-cursor {
          color: var(--accent-dim);
          font-size: 12px;
          animation: fade-in 700ms ease-in-out infinite alternate;
        }
        .turn-error {
          color: var(--status-error);
          font-size: 12.5px;
        }
        .chat-input-bar {
          flex: 0 0 auto;
          padding: 14px 40px 20px;
          background: var(--ground-raised);
          border-top: 1px solid var(--panel-border);
          box-shadow: var(--bevel-out);
        }
        .chat-input-wrap {
          display: flex;
          align-items: flex-end;
          gap: 12px;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          padding: 8px 8px 8px 14px;
        }
        .chat-input-wrap:focus-within {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          resize: none;
          color: var(--ink);
          font-family: var(--font-body);
          font-size: 14.5px;
          line-height: 1.5;
          padding: 8px 0;
          caret-color: var(--accent);
        }
        .chat-input::placeholder {
          color: var(--ink-faint);
        }
        .chat-input:focus {
          outline: none;
        }
        .chat-send {
          flex: 0 0 auto;
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          border-radius: 2px;
          font-family: var(--font-body);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #fff;
          padding: 9px 16px;
          box-shadow: var(--bevel-out), var(--shadow-card);
        }
        .chat-send:hover:not(:disabled) {
          transform: translate(1px, 1px);
          box-shadow: var(--bevel-out);
        }
        .chat-send:active:not(:disabled) {
          box-shadow: var(--bevel-in);
        }
        .chat-send:disabled {
          background: var(--ground-raised);
          border-color: var(--chrome-lo);
          color: var(--ink-faint);
          box-shadow: var(--bevel-out);
          transform: none;
          cursor: default;
        }
        .chat-input-hint {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 10px;
          color: var(--ink-dimmer);
          margin: 10px 0 0;
          user-select: none;
        }
        .chat-model-label {
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-weight: 700;
        }
        .chat-model-select {
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: var(--ink);
          font-size: 10px;
          padding: 2px 4px;
        }
        .chat-model-select:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .preview-scrim {
          position: fixed;
          inset: 0;
          z-index: 40;
        }
        .preview-pop {
          position: fixed;
          top: 64px;
          right: 24px;
          width: 340px;
          max-width: calc(100vw - 48px);
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--bevel-out), 3px 4px 0 rgba(23, 25, 27, 0.3);
          z-index: 41;
          animation: preview-pop-in var(--dur-med) var(--ease-out) both;
        }
        @keyframes preview-pop-in {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .preview-pop-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 7px 10px;
          box-shadow: inset 0 -1px 0 var(--chrome-lo);
        }
        .preview-pop-close {
          background: none;
          border: none;
          color: var(--ink-dim);
          font-family: var(--font-mono);
          font-size: 12px;
          padding: 2px 4px;
        }
        .preview-pop-close:hover {
          color: var(--ink);
        }
        .preview-pop-body {
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .preview-pop-loading,
        .preview-pop-error {
          padding: 24px 8px;
          text-align: center;
          font-size: 11px;
          color: var(--ink-dimmer);
        }
        .preview-pop-error {
          color: var(--status-error);
        }
        .preview-bezel {
          background: var(--bezel);
          border: 1px solid var(--panel-border);
          border-radius: 1px;
          overflow: hidden;
        }
        .preview-video {
          width: 100%;
          display: block;
          aspect-ratio: 16 / 9;
          background: var(--bezel);
        }
        .preview-audio-wrap {
          min-height: 118px;
          padding: 20px 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          align-items: center;
          justify-content: center;
        }
        .preview-audio-label {
          color: var(--status-warn);
          align-self: flex-start;
        }
        .preview-audio {
          width: 100%;
          height: 34px;
          color-scheme: dark;
          accent-color: var(--accent);
        }
        .preview-unavailable {
          min-height: 118px;
          padding: 20px;
          display: grid;
          place-items: center;
          text-align: center;
          color: var(--bezel-ink);
          font-size: 11px;
          line-height: 1.6;
        }
        .preview-meta {
          padding: 8px 2px 2px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .preview-meta-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--ink-dim);
        }
        .preview-meta-row .mono {
          color: var(--ink);
        }
        .preview-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding-top: 6px;
        }
        @media (max-width: 560px) {
          .preview-scrim {
            background: rgba(23, 25, 27, 0.25);
          }
          .preview-pop {
            top: auto;
            right: 0;
            bottom: 0;
            left: 0;
            width: 100%;
            max-width: none;
            border-radius: 2px 2px 0 0;
            animation: preview-sheet-in var(--dur-med) var(--ease-out) both;
          }
          @keyframes preview-sheet-in {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .preview-pop {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

interface TurnAnswerProps {
  answer: DisplayAnswer;
  onPlay: (hit: AnswerHit, returnFocusId: string) => void;
  /** Play-button id for the hit whose preview pop-over is currently open. */
  activePreviewKey: string | null;
  /** fileId -> reason, populated once a real load attempt finds no playable path. */
  unplayableFiles: Map<number, string>;
  onExportLocators: (hits: AnswerHit[]) => Promise<LocatorExportOutcome>;
  onExportSuccess: (outcome: Extract<LocatorExportOutcome, { kind: "written" }>) => void;
  onLegacyExport: (hits: AnswerHit[]) => void;
}

function TurnAnswer({ answer, onPlay, activePreviewKey, unplayableFiles, onExportLocators, onExportSuccess, onLegacyExport }: TurnAnswerProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const [blockedReason, setBlockedReason] = useState<"no-hits" | "no-valid-sources" | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  function flipCopied(key: string, text: string) {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedKey(null), 1000);
  }

  async function handleExportClick(hits: AnswerHit[]) {
    setExportPending(true);
    setBlockedReason(null);
    try {
      const outcome = await onExportLocators(hits);
      if (outcome.kind === "blocked") setBlockedReason(outcome.reason);
      else onExportSuccess(outcome);
    } finally {
      setExportPending(false);
    }
  }

  let body: ReactNode;

  if (answer.kind === "message") {
    body = <p className="answer-message">{answer.text}</p>;
  } else if (answer.kind === "empty") {
    const count = answer.coverage.searchableFiles;
    body = (
      <div className="answer-empty">
        <p>No hits in this scope.</p>
        <p className="answer-empty-meta mono">
          {count} {count === 1 ? "file" : "files"} searched · 0 hits
        </p>
      </div>
    );
  } else if (answer.kind === "legacy-visual") {
    body = (
      <>
        <p className="answer-message">{answer.prose}</p>
        <div className="legacy-hit-grid">
          {answer.hits.map((hit, i) => {
            const returnFocusId = `legacy-hit-${hitIdentity(hit, i)}`;
            return (
              <div key={returnFocusId} id={returnFocusId} tabIndex={-1} className="legacy-hit-focus-wrap">
                <HitCard hit={hit} index={i} onOpen={(h) => onPlay(h, returnFocusId)} />
              </div>
            );
          })}
        </div>
        {answer.hits.length > 0 && (
          <div className="legacy-footer">
            <button className="ghost-btn label" onClick={() => onLegacyExport(answer.hits)}>
              Export markers
            </button>
          </div>
        )}
      </>
    );
  } else {
    const hits = answer.hits;
    const markerCount = hits.length;
    const clipCount = new Set(hits.map((hit) => hit.fileId)).size;
    body = (
      <div className="answer">
        {answer.summary && <p className="answer-summary">{answer.summary}</p>}
        {hits.map((hit, index) => {
          const key = hitIdentity(hit, index);
          const active = copiedKey === key;
          const playId = `hit-play-${key}`;
          const previewing = activePreviewKey === playId;
          const unplayableReasonForHit = unplayableFiles.get(hit.fileId) ?? null;
          const quoteText = normalizeCopyLine(hit.quote ?? hit.description ?? "");
          const whyText = hit.quote && hit.description ? normalizeCopyLine(hit.description) : null;
          return (
            <div className={`hit${previewing ? " selected" : ""}`} key={key}>
              <button
                id={playId}
                className="hit-play"
                onClick={() => onPlay(hit, playId)}
                aria-label={unplayableReasonForHit ? `${hit.filename}: ${unplayableReasonForHit}` : `Play ${hit.filename} at ${hit.inTc}`}
                title={unplayableReasonForHit ?? undefined}
                disabled={Boolean(unplayableReasonForHit)}
              >
                ▶
              </button>
              <span className="hit-text">
                <span className="hit-quote">"{quoteText}"</span>
                {whyText && (
                  <span className="hit-why">
                    <span className="hit-why-label label">Why</span>
                    <span className="hit-why-text">{whyText}</span>
                  </span>
                )}
                <span className="hit-meta">
                  <span className="clip">{hit.filename}</span>
                  <span
                    title={hit.sourceRateFallback ? "source rate unknown; 30fps basis" : undefined}
                  >
                    {hit.inTc}{hit.sourceRateFallback ? "*" : ""}
                  </span>
                  <span className="dot" style={{ background: CONFIDENCE_DOT_COLOR[hit.confidence] }} />
                </span>
              </span>
              <button
                className={`ghost-btn label hit-copy${active ? " btn-primary" : ""}`}
                onClick={() => flipCopied(key, formatHitCopyLine(hit))}
              >
                {active ? "Copied" : "Copy"}
              </button>
            </div>
          );
        })}
        <div className="answer-foot">
          <button className="ghost-btn label btn-primary" onClick={() => flipCopied("all", formatHitsCopyAll(hits))}>
            {copiedKey === "all" ? "Copied" : "Copy all"}
          </button>
          <button className="ghost-btn label" onClick={() => void handleExportClick(hits)} disabled={exportPending}>
            {exportPending
              ? "Exporting…"
              : `Export ${markerCount} ${markerCount === 1 ? "marker" : "markers"} · ${clipCount} ${clipCount === 1 ? "clip" : "clips"}`}
          </button>
          <span className="hint mono">copy writes: "line" · clip · timecode</span>
        </div>
        {blockedReason && (
          <div className="banner err mono">
            EXPORT STOPPED · 0 MARKERS WOULD BE WRITTEN ·{" "}
            {blockedReason === "no-hits" ? "NO HITS IN THIS ANSWER" : "SOURCE FILES ARE OUT OF SCOPE OR NO LONGER AVAILABLE"}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="turn-answer">
      {body}

      <style>{`
        .turn-answer {
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .answer-message {
          font-size: 14.5px;
          line-height: 1.7;
          color: var(--ink-dim);
          margin: 0;
        }
        .answer-empty {
          background: #fff;
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          padding: 12px 14px;
        }
        .answer-empty p {
          font-size: 13px;
          line-height: 1.5;
          color: var(--ink);
          margin: 0;
        }
        .answer-empty-meta {
          margin-top: 6px !important;
          font-size: 11px;
          color: var(--ink-faint);
        }
        .answer {
          background: #fff;
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          overflow: hidden;
        }
        .answer-summary {
          padding: 12px 14px;
          font-size: 13px;
          line-height: 1.5;
          color: var(--ink);
          margin: 0;
          border-bottom: 1px solid var(--hairline);
        }
        .hit {
          display: grid;
          grid-template-columns: 34px 1fr auto;
          gap: 0 10px;
          align-items: start;
          padding: 10px 12px 10px 8px;
        }
        .hit:nth-child(even) {
          background: var(--paper-alt);
        }
        .hit-play {
          width: 24px;
          height: 24px;
          margin-top: 1px;
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          background: var(--ground-raised);
          box-shadow: var(--bevel-out);
          display: grid;
          place-items: center;
          font-size: 9px;
          color: var(--ink);
        }
        .hit-play:hover:not(:disabled) {
          background: #d2d6d9;
        }
        .hit-play:active:not(:disabled) {
          box-shadow: var(--bevel-in);
        }
        .hit-play:disabled {
          color: var(--ink-faint);
          box-shadow: var(--bevel-in);
          cursor: default;
        }
        .hit-text {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .hit-quote {
          font-size: 13px;
          line-height: 1.5;
          color: var(--ink);
        }
        .hit-why {
          display: flex;
          align-items: baseline;
          gap: 6px;
          margin-top: 4px;
        }
        .hit-why-label {
          flex: 0 0 auto;
          font-size: 8.5px;
          color: var(--ink-faint);
        }
        .hit-why-text {
          font-size: 12px;
          line-height: 1.5;
          color: var(--ink-dim);
        }
        .hit.selected .hit-why-label,
        .hit.selected .hit-why-text {
          color: #9aa3ad;
        }
        .hit-meta {
          margin-top: 4px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--ink-dim);
          display: flex;
          gap: 8px;
          align-items: center;
          font-variant-numeric: tabular-nums;
        }
        .hit-meta .clip {
          color: var(--accent);
        }
        .dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex: 0 0 auto;
        }
        .hit-copy {
          margin-top: 1px;
          padding: 5px 9px;
          font-size: 9.5px;
          white-space: nowrap;
        }
        .hit.selected {
          background: var(--select-bg);
          color: var(--select-ink);
        }
        .hit.selected .hit-meta {
          color: #9aa3ad;
        }
        .hit.selected .hit-meta .clip {
          color: #8fb4dd;
        }
        .hit.selected .hit-quote {
          color: var(--select-ink);
        }
        .hit.selected .hit-play,
        .hit.selected .hit-copy {
          background: #2a2d31;
          color: var(--select-ink);
          box-shadow: none;
          border-color: #45494e;
        }
        .hit.selected .hit-play:disabled {
          color: #9aa3ad;
        }
        .legacy-hit-focus-wrap {
          outline: none;
          border-radius: 2px;
        }
        .legacy-hit-focus-wrap:focus {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .answer-foot {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-top: 1px solid var(--hairline);
          background: var(--ground-card);
        }
        .hint {
          font-size: 10px;
          color: var(--ink-faint);
          margin-left: auto;
        }
        .ghost-btn.btn-primary,
        .ghost-btn.btn-primary:hover {
          background: var(--select-bg);
          border-color: var(--select-bg);
          color: var(--select-ink);
          box-shadow: none;
        }
        .banner {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          font-size: 11px;
        }
        .banner.err {
          background: #f2dcd8;
          color: var(--status-error);
          border-top: 1px solid var(--status-error);
        }
        .legacy-hit-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 14px;
          margin: 20px 0;
        }
        .legacy-footer {
          display: flex;
        }
        @media (max-width: 560px) {
          .hit {
            grid-template-columns: 34px 1fr;
          }
          .hit-copy {
            grid-column: 1 / -1;
            justify-self: start;
            margin-top: 8px;
          }
          .answer-foot {
            flex-wrap: wrap;
          }
          .hint {
            margin-left: 0;
            flex-basis: 100%;
          }
          .legacy-hit-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}
