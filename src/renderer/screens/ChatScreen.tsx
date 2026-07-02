import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentAnswer, AnswerHit, ExportItem, ExportKind } from "../../shared/types";
import { ActivityLine } from "../components/ActivityLine";
import { HitCard } from "../components/HitCard";
import { Toast } from "../components/Toast";

interface ChatScreenProps {
  onOpenClip: (fileId: number, seekS: number) => void;
  /** null while settings are loading; false shows the setup hint. */
  anthropicKeySet?: boolean | null;
  onOpenSettings?: () => void;
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

export function ChatScreen({ onOpenClip, anthropicKeySet, onOpenSettings }: ChatScreenProps) {
  const [chatId, setChatId] = useState<number | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTurnIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = api.onChatEvent((ev) => {
      const turnId = activeTurnIdRef.current;
      if (!turnId) return;
      if (ev.type === "activity") {
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, activity: [...t.activity, { agent: ev.agent, status: ev.status }] } : t)),
        );
      } else if (ev.type === "answer") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, answer: ev.answer } : t)));
      } else if (ev.type === "error") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: ev.message, pending: false } : t)));
      } else if (ev.type === "done") {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, pending: false } : t)));
        activeTurnIdRef.current = null;
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");

    const turnId = `${Date.now()}`;
    activeTurnIdRef.current = turnId;
    setTurns((prev) => [...prev, { id: turnId, question: text, activity: [], answer: null, error: null, pending: true }]);

    try {
      const res = await api.sendChatMessage(chatId, text);
      setChatId(res.chatId);
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, pending: false, error: err instanceof Error ? err.message : "Something went wrong." } : t)),
      );
      activeTurnIdRef.current = null;
    }
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

  return (
    <div className="chat-screen">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-column">
          {isEmpty && (
            <div className="chat-empty">
              <p className="display chat-empty-line">Ask your footage anything.</p>
              <p className="chat-empty-sub">
                Search transcripts and visuals together — "bears fishing at the river bend," "where does Marsh mention the
                salmon run."
              </p>
              {anthropicKeySet === false && onOpenSettings && (
                <button className="chat-key-hint" onClick={onOpenSettings}>
                  No API key yet — set one up in Settings →
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
            <button className="chat-send label" onClick={handleSend} disabled={!input.trim()}>
              Send
            </button>
          </div>
          <p className="chat-input-hint mono">⌘⏎ to send</p>
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
        .chat-empty {
          padding-top: 18vh;
          text-align: center;
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
