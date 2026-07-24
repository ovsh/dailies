import { useState } from "react";
import type { Episode } from "../../shared/types";

interface EpisodeBarProps {
  episodes: Episode[];
  /** null = ALL (whole-project scope). */
  activeEpisodeId: number | null;
  onSelect: (id: number | null) => void;
  onCreate: (code: string) => Promise<void>;
  /** Layout variant: "inline" sits in a header row, "centered" stands alone above content. */
  size?: "inline" | "centered";
}

/**
 * A quiet row of episode chips: ALL, then each episode code, then a "+" to
 * add one inline (no native prompt()). Active chip gets black-inverse selection.
 */
export function EpisodeBar({ episodes, activeEpisodeId, onSelect, onCreate, size = "inline" }: EpisodeBarProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    const code = draft.trim();
    if (!code) {
      setAdding(false);
      return;
    }
    setSaving(true);
    await onCreate(code);
    setSaving(false);
    setDraft("");
    setAdding(false);
  }

  return (
    <div className={`episode-bar episode-bar-${size}`}>
      <button
        className={`episode-chip label${activeEpisodeId === null ? " active" : ""}`}
        onClick={() => onSelect(null)}
      >
        ALL
      </button>
      {episodes.map((ep) => (
        <button
          key={ep.id}
          className={`episode-chip mono${activeEpisodeId === ep.id ? " active" : ""}`}
          onClick={() => onSelect(ep.id)}
        >
          {ep.code}
        </button>
      ))}

      {adding ? (
        <input
          className="episode-chip-input mono"
          autoFocus
          value={draft}
          placeholder="code"
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setAdding(false);
              setDraft("");
            }
          }}
          onBlur={submit}
        />
      ) : (
        <button className="episode-chip episode-chip-add" onClick={() => setAdding(true)} aria-label="Add episode">
          +
        </button>
      )}

      <style>{`
        .episode-bar {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .episode-bar-centered {
          justify-content: center;
        }
        .episode-chip {
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: var(--ink);
          padding: 5px 11px;
          font-size: 11px;
        }
        .episode-chip:hover {
          background: #d2d6d9;
        }
        .episode-chip:active {
          box-shadow: var(--bevel-in);
        }
        .episode-chip.active {
          background: var(--select-bg);
          border-color: var(--select-bg);
          color: var(--select-ink);
          box-shadow: none;
        }
        .episode-chip-add {
          color: var(--ink-dim);
          width: 26px;
          padding: 5px 0;
          text-align: center;
        }
        .episode-chip-add:hover {
          color: var(--ink);
        }
        .episode-chip-input {
          width: 58px;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          color: var(--ink);
          padding: 5px 9px;
          font-size: 11px;
        }
        .episode-chip-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .episode-chip-input::placeholder {
          color: var(--ink-faint);
        }
      `}</style>
    </div>
  );
}
