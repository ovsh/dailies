import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  AgentAnswer,
  AnswerHit,
  ChatMessageRecord,
  ChatSummary,
  Episode,
  ExportItem,
  ExportKind,
} from "../../shared/types";
import { ActivityLine } from "../components/ActivityLine";
import { EpisodeBar } from "../components/EpisodeBar";
import { HitCard } from "../components/HitCard";
import { Toast } from "../components/Toast";

interface ChatScreenProps {
  onOpenClip: (fileId: number, seekS: number) => void;
  /** null while settings are loading; false shows the setup hint. */
  apiKeySet?: boolean | null;
  onOpenSettings?: () => void;
  /** Current episode scope; null = whole project. */
  episodeId: number | null;
  episodes: Episode[];
  onEpisodeChange: (id: number | null) => void;
  onCreateEpisode: (code: string) => Promise<void>;
}

interface ActivityEvent {
  agent: string;
  status: string;
}

interface Turn {
  id: string;
  question: string;
  activity: ActivityEvent[];
  answer: AgentAnswer | null;
  error: string | null;
  pending: boolean;
}

interface ToastState {
  message: string;
  action?: { label: string; onClick: () => void };
}

function confidenceRank(c: AnswerHit["confidence"]): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

function formatChatDate(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.toLocaleString("en-US", { day: "2-digit", month: "short" })}${year}`.toUpperCase();
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
      current.answer = { prose: message.content, hits: message.hits ?? [] };
    }
  }

  return historicalTurns;
}

export function ChatScreen({
  onOpenClip,
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
  const [toast, setToast] = useState<ToastState | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnCounterRef = useRef(0);
  const runningTurnIdRef = useRef<string | null>(null);
  const historyGenerationRef = useRef(0);

  const refreshChats = useCallback(async () => {
    setChatsLoading(true);
    try {
      setChats(await api.listChats());
      setHistoryError(null);
    } catch {
      setHistoryError("Could not load conversations.");
    } finally {
      setChatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

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
    setChatId(selectedChatId);
    setTurns([]);
    setConversationLoading(true);
    setHistoryError(null);
    try {
      const messages = await api.getChat(selectedChatId);
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
    setChatId(null);
    setTurns([]);
    setInput("");
    setHistoryError(null);
    setConversationLoading(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleExport(kind: ExportKind, hits: AnswerHit[]) {
    const items: ExportItem[] = hits.map((h) => ({
      fileId: h.fileId,
      inTc: h.inTc,
      outTc: h.outTc,
      inS: h.inS,
      outS: h.outS,
      comment: h.quote ?? h.description ?? "",
      color: h.confidence === "high" ? "green" : h.confidence === "medium" ? "yellow" : undefined,
    }));
    const result = await api.exportHits(kind, items);
    setToast({
      message: `Exported ${result.count} ${result.count === 1 ? "marker" : "markers"} — ${result.path.split("/").pop()}`,
      action: { label: "Reveal in Finder", onClick: () => api.revealInFinder(result.path) },
    });
  }

  const isEmpty = turns.length === 0;
  const isAnswering = turns.some((turn) => turn.pending);
  const activeEpisode = episodeId === null ? null : episodes.find((e) => e.id === episodeId) ?? null;

  return (
    <div className="chat-screen">
      <aside className="chat-history" aria-label="Past conversations">
        <div className="chat-history-head">
          <span className="label">Conversations</span>
          <button className="chat-new label" onClick={handleNewChat} disabled={isAnswering}>
            + New
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
              <span className="chat-history-date mono">{formatChatDate(chat.createdAt)}</span>
            </button>
          ))}
          {chatsLoading && chats.length === 0 && <span className="chat-history-note mono">Loading…</span>}
          {!chatsLoading && chats.length === 0 && !historyError && (
            <span className="chat-history-note mono">No past chats.</span>
          )}
          {historyError && <span className="chat-history-note error mono">{historyError}</span>}
        </div>
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

            {conversationLoading && <p className="chat-conversation-loading mono">Loading conversation…</p>}

            {isEmpty && !conversationLoading && (
              <div className="chat-empty">
                <p className="display chat-empty-line">Ask your footage anything.</p>
                <p className="chat-empty-sub">
                  Search transcripts and producer notes — "where does Marsh mention the salmon run?"
                </p>
                {activeEpisode && <p className="chat-empty-scope mono">Searching episode {activeEpisode.code}</p>}
                {apiKeySet === false && onOpenSettings && (
                  <button className="chat-key-hint" onClick={onOpenSettings}>
                    No OpenRouter key yet — set one up in Settings →
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
                  <TurnAnswer answer={turn.answer} onOpenClip={onOpenClip} onExport={(kind, hits) => handleExport(kind, hits)} />
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
              <button className="chat-send label" onClick={handleSend} disabled={!input.trim() || isAnswering}>
                {isAnswering ? "Answering…" : "Send"}
              </button>
            </div>
            <p className="chat-input-hint mono">⌘⏎ to send</p>
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

      <style>{`
        .chat-screen {
          height: 100%;
          display: flex;
          min-width: 0;
        }
        .chat-history {
          flex: 0 0 216px;
          min-width: 0;
          padding: 50px 14px 22px;
          border-right: 1px solid var(--hairline);
          background: rgba(35, 40, 51, 0.45);
          overflow: hidden;
        }
        .chat-history-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0 7px 13px;
          border-bottom: 1px solid var(--hairline);
        }
        .chat-new {
          border: 0;
          background: transparent;
          color: var(--ink-dimmer);
          padding: 3px 0;
          font-size: 9.5px;
          transition: color var(--dur-fast) var(--ease-out);
        }
        .chat-new:hover:not(:disabled) {
          color: var(--accent);
        }
        .chat-new:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
        .chat-history-list {
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding-top: 10px;
          overflow-y: auto;
          max-height: calc(100% - 36px);
        }
        .chat-history-item {
          width: 100%;
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 4px;
          border: 1px solid transparent;
          border-radius: 5px;
          background: transparent;
          padding: 9px 8px 8px;
          transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
        }
        .chat-history-item:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.025);
          border-color: var(--hairline);
        }
        .chat-history-item.active {
          background: var(--accent-wash);
          border-color: var(--hairline-strong);
        }
        .chat-history-item:disabled {
          cursor: default;
        }
        .chat-history-title {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--ink-dim);
          font-size: 11.5px;
        }
        .chat-history-item.active .chat-history-title {
          color: var(--ink);
        }
        .chat-history-date {
          color: var(--ink-faint);
          font-size: 9px;
        }
        .chat-history-note {
          padding: 8px;
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
        .chat-empty {
          padding-top: 14vh;
          text-align: center;
        }
        .chat-conversation-loading {
          padding-top: 14vh;
          text-align: center;
          color: var(--ink-faint);
          font-size: 10.5px;
        }
        .chat-empty-line {
          font-size: 34px;
          color: var(--ink);
          margin: 0 0 14px;
        }
        .chat-empty-sub {
          font-size: 13.5px;
          color: var(--ink-dimmer);
          max-width: 440px;
          margin: 0 auto;
          line-height: 1.6;
        }
        .chat-empty-scope {
          margin: 18px 0 0;
          font-size: 11px;
          color: var(--ink-faint);
        }
        .chat-key-hint {
          margin-top: 26px;
          background: transparent;
          border: 1px solid var(--hairline-strong);
          border-radius: 6px;
          padding: 9px 16px;
          font-size: 12px;
          color: var(--accent);
          transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
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
          padding: 14px 40px 26px;
          background: linear-gradient(to top, var(--ground) 65%, transparent);
        }
        .chat-input-wrap {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          border-bottom: 1px solid var(--hairline-strong);
          transition: border-color var(--dur-fast) var(--ease-out);
        }
        .chat-input-wrap:focus-within {
          border-color: var(--accent-dim);
        }
        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          resize: none;
          color: var(--ink);
          font-family: var(--font-body);
          font-size: 15.5px;
          line-height: 1.5;
          padding: 12px 0 14px;
          caret-color: var(--accent);
        }
        .chat-input::placeholder {
          color: var(--ink-dimmer);
        }
        .chat-input:focus {
          outline: none;
        }
        .chat-send {
          background: transparent;
          border: none;
          color: var(--ink-dimmer);
          padding: 0 0 16px;
          transition: color var(--dur-fast) var(--ease-out);
        }
        .chat-send:hover:not(:disabled) {
          color: var(--accent);
        }
        .chat-send:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
        .chat-input-hint {
          font-size: 10px;
          color: var(--ink-faint);
          margin: 10px 0 0;
          user-select: none;
        }
      `}</style>
    </div>
  );
}

interface TurnAnswerProps {
  answer: AgentAnswer;
  onOpenClip: (fileId: number, seekS: number) => void;
  onExport: (kind: ExportKind, hits: AnswerHit[]) => void;
}

function TurnAnswer({ answer, onOpenClip, onExport }: TurnAnswerProps) {
  const sorted = [...answer.hits].sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));

  return (
    <div className="turn-answer">
      <p className="turn-prose">{answer.prose}</p>

      <div className="hit-grid">
        {sorted.map((hit, i) => (
          <HitCard key={`${hit.fileId}-${hit.inS}`} hit={hit} index={i} onOpen={(h) => onOpenClip(h.fileId, h.inS)} />
        ))}
      </div>

      <div className="turn-footer">
        <button className="turn-footer-btn label" onClick={() => onExport("locators", answer.hits)}>
          Export markers
        </button>
        <span className="turn-footer-sep">·</span>
        <button className="turn-footer-btn label" onClick={() => onExport("edl", answer.hits)}>
          Export EDL
        </button>
      </div>

      <style>{`
        .turn-answer {
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .turn-prose {
          font-size: 14.5px;
          line-height: 1.75;
          color: var(--ink-dim);
          margin: 0 0 24px;
        }
        .hit-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 14px;
          margin-bottom: 20px;
        }
        .turn-footer {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .turn-footer-btn {
          background: transparent;
          border: none;
          color: var(--ink-dimmer);
          padding: 0;
          transition: color var(--dur-fast) var(--ease-out);
        }
        .turn-footer-btn:hover {
          color: var(--accent);
        }
        .turn-footer-sep {
          color: var(--ink-faint);
          font-size: 11px;
        }
      `}</style>
    </div>
  );
}
