import { useEffect, useRef, useState } from "react";
import type { Episode } from "../../shared/types";
import { api } from "../api";

interface EpisodeSelectProps {
  episodes: Episode[];
  /** null = ALL (whole-project scope). */
  activeEpisodeId: number | null;
  onSelect: (id: number | null) => void;
  onCreate: (code: string) => Promise<void>;
  /** Layout variant: "inline" sits in a header row, "centered" stands alone above content. */
  align?: "inline" | "centered";
}

interface ClipCounts {
  totalFiles: number;
  perEpisode: Map<number, number>;
}

/** An episode's display name: the editable title when set, else its code. */
export function episodeDisplayName(episode: Episode): string {
  return episode.title ?? episode.code;
}

/** The scope line for headers: "203 · Auckland & Pretoria", or the code alone. */
export function episodeScopeLabel(episode: Episode): string {
  return episode.title ? `${episode.code} · ${episode.title}` : `Episode ${episode.code}`;
}

/**
 * The bin selector: one compact control that names the active scope, with a
 * menu of every episode (code, title, clip count), inline rename with an
 * optional model suggestion, and inline create. Replaces the old chip row,
 * which overflowed the moment codes were long or episodes were many.
 */
export function EpisodeSelect({
  episodes,
  activeEpisodeId,
  onSelect,
  onCreate,
  align = "inline",
}: EpisodeSelectProps) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<ClipCounts | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const active = activeEpisodeId === null
    ? null
    : episodes.find((ep) => ep.id === activeEpisodeId) ?? null;

  // Counts refresh on open only; the episodes array gets a new identity on
  // every project-update tick, which must not refetch an open menu in a loop.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .getEpisodeClipCounts()
      .then((tally) => {
        if (cancelled) return;
        setCounts({
          totalFiles: tally.totalFiles,
          perEpisode: new Map(tally.rows.map((row) => [row.episodeId, row.clipCount])),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Outside click / Escape close the menu without stealing either event.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: PointerEvent) {
      if (rootRef.current && ev.target instanceof Node && !rootRef.current.contains(ev.target)) {
        close();
      }
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") close();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Keyboard model: the active scope takes focus on open, arrows traverse rows.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const items = list.querySelectorAll<HTMLButtonElement>(".episode-menu-pick");
    const activeItem = [...items].find((item) => item.getAttribute("aria-checked") === "true");
    (activeItem ?? items[0])?.focus();
  }, [open]);

  function onMenuKeyDown(ev: React.KeyboardEvent) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") {
      return;
    }
    const list = listRef.current;
    if (!list) return;
    const items = [...list.querySelectorAll<HTMLButtonElement>(".episode-menu-pick")];
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next =
      ev.key === "Home" ? 0
      : ev.key === "End" ? items.length - 1
      : ev.key === "ArrowDown" ? (current + 1 + items.length) % items.length
      : (current - 1 + items.length) % items.length;
    items[next]?.focus();
    ev.preventDefault();
  }

  function close() {
    setOpen(false);
    setRenamingId(null);
    setSuggestNote(null);
    setAdding(false);
    setAddDraft("");
    controlRef.current?.focus();
  }

  function pick(id: number | null) {
    onSelect(id);
    close();
  }

  function startRename(episode: Episode) {
    setRenamingId(episode.id);
    setRenameDraft(episode.title ?? "");
    setSuggestNote(null);
  }

  async function commitRename(episodeId: number) {
    if (renameBusy) return;
    setRenameBusy(true);
    try {
      await api.renameEpisode(episodeId, renameDraft);
      setRenamingId(null);
      setSuggestNote(null);
    } catch {
      // Keep the editor open; the draft is still there to retry or cancel.
    } finally {
      setRenameBusy(false);
    }
  }

  async function suggestTitle(episodeId: number) {
    if (suggestBusy) return;
    setSuggestBusy(true);
    setSuggestNote(null);
    try {
      const suggestion = await api.suggestEpisodeTitle(episodeId);
      if (suggestion) setRenameDraft(suggestion);
      else setSuggestNote("No suggestion");
    } catch {
      setSuggestNote("No suggestion");
    } finally {
      setSuggestBusy(false);
    }
  }

  async function submitCreate() {
    const code = addDraft.trim();
    if (!code) {
      setAdding(false);
      setAddDraft("");
      return;
    }
    setAddBusy(true);
    try {
      await onCreate(code);
      setAddDraft("");
      setAdding(false);
    } finally {
      setAddBusy(false);
    }
  }

  const countFor = (id: number) => counts?.perEpisode.get(id);

  return (
    <div className={`episode-select episode-select-${align}`} ref={rootRef}>
      <button
        type="button"
        ref={controlRef}
        className="episode-select-control"
        aria-haspopup="menu"
        aria-expanded={open}
        title={active?.title ?? undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="label episode-select-kicker">Episode</span>
        {active ? (
          <>
            <span className="mono episode-select-code">{active.code}</span>
            {active.title && <span className="episode-select-title">{active.title}</span>}
          </>
        ) : (
          <span className="episode-select-title">All episodes</span>
        )}
        <span className="episode-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="episode-menu" role="menu" aria-label="Episode scope" onKeyDown={onMenuKeyDown}>
          <div className="episode-menu-head">
            <span className="label">
              Episodes
              {counts !== null && ` · ${counts.totalFiles} ${counts.totalFiles === 1 ? "clip" : "clips"}`}
            </span>
          </div>

          <div className="episode-menu-list" ref={listRef}>
            <div className={`episode-menu-row${activeEpisodeId === null ? " active" : ""}`}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={activeEpisodeId === null}
                className="episode-menu-pick"
                onClick={() => pick(null)}
              >
                <span className="mono episode-menu-code">ALL</span>
                <span className="episode-menu-title">All episodes</span>
                {counts !== null && <span className="mono episode-menu-count">{counts.totalFiles}</span>}
              </button>
            </div>

            {episodes.map((episode) =>
              renamingId === episode.id ? (
                <div key={episode.id} className="episode-menu-row renaming">
                  <span className="mono episode-menu-code">{episode.code}</span>
                  <input
                    className="episode-menu-rename-input"
                    autoFocus
                    value={renameDraft}
                    placeholder={episode.code}
                    disabled={renameBusy}
                    aria-label={`Title for episode ${episode.code}`}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(episode.id);
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenamingId(null);
                        setSuggestNote(null);
                      }
                    }}
                  />
                  {suggestNote ? (
                    <span className="episode-menu-suggest-note mono">{suggestNote}</span>
                  ) : (
                    <button
                      type="button"
                      className="episode-menu-suggest label"
                      disabled={suggestBusy}
                      onClick={() => void suggestTitle(episode.id)}
                      title="Ask the chat model for a short title"
                    >
                      {suggestBusy ? "…" : "Suggest"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="episode-menu-save label"
                    disabled={renameBusy}
                    onClick={() => void commitRename(episode.id)}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <div
                  key={episode.id}
                  className={`episode-menu-row${episode.id === activeEpisodeId ? " active" : ""}`}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={episode.id === activeEpisodeId}
                    className="episode-menu-pick"
                    onClick={() => pick(episode.id)}
                    title={episode.mediaTag ?? undefined}
                  >
                    {episode.title ? (
                      <>
                        <span className="mono episode-menu-code">{episode.code}</span>
                        <span className="episode-menu-title">{episode.title}</span>
                      </>
                    ) : (
                      <span className="mono episode-menu-title">{episode.code}</span>
                    )}
                    {countFor(episode.id) !== undefined && (
                      <span className="mono episode-menu-count">{countFor(episode.id)}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="episode-menu-rename label"
                    onClick={() => startRename(episode)}
                    aria-label={`Rename episode ${episode.code}`}
                  >
                    Rename
                  </button>
                </div>
              ),
            )}
          </div>

          <div className="episode-menu-foot">
            {adding ? (
              <input
                className="episode-menu-add-input mono"
                autoFocus
                value={addDraft}
                placeholder="code, e.g. 204 · Enter adds"
                disabled={addBusy}
                aria-label="New episode code"
                onChange={(e) => setAddDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCreate();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setAdding(false);
                    setAddDraft("");
                  }
                }}
              />
            ) : (
              <button type="button" className="episode-menu-new label" onClick={() => setAdding(true)}>
                New episode…
              </button>
            )}
          </div>
        </div>
      )}

      <style>{`
        .episode-select {
          position: relative;
          display: inline-flex;
          min-width: 0;
        }
        .episode-select-centered {
          justify-content: center;
        }
        .episode-select-control {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: var(--ink);
          padding: 5px 11px;
          font-size: 11.5px;
          max-width: 340px;
        }
        .episode-select-control:hover {
          background: #d2d6d9;
        }
        .episode-select-control:active {
          box-shadow: var(--bevel-in);
        }
        .episode-select-kicker {
          flex: 0 0 auto;
          white-space: nowrap;
          color: var(--ink-dimmer);
        }
        .episode-select-code {
          flex: 0 0 auto;
          white-space: nowrap;
          font-size: 10.5px;
          color: var(--ink-dim);
        }
        .episode-select-title {
          min-width: 0;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .episode-select-caret {
          flex: 0 0 auto;
          font-size: 8px;
          color: var(--ink-dim);
        }
        .episode-menu {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          width: 330px;
          max-height: min(52vh, 420px);
          display: flex;
          flex-direction: column;
          background: var(--ground-card);
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--shadow-card);
          z-index: 30;
        }
        .episode-select-centered .episode-menu {
          left: 50%;
          transform: translateX(-50%);
        }
        .episode-menu-head {
          flex: 0 0 auto;
          padding: 7px 12px 6px;
          border-bottom: 1px solid var(--hairline);
        }
        .episode-menu-list {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
        }
        .episode-menu-row {
          position: relative;
          display: flex;
          align-items: stretch;
          border-bottom: 1px solid var(--hairline);
        }
        .episode-menu-row:nth-child(odd) {
          background: var(--paper-alt);
        }
        .episode-menu-row:hover:not(.active):not(.renaming) {
          background: #e2e5e7;
        }
        .episode-menu-row.active {
          background: var(--select-bg);
          color: var(--select-ink);
        }
        .episode-menu-pick {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
          background: none;
          border: none;
          padding: 7px 12px;
          color: inherit;
          font-size: 12px;
          text-align: left;
        }
        /* Rows bleed edge to edge, so the focus ring sits inside the row. */
        .episode-menu-pick:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: -2px;
        }
        .episode-menu-row.active .episode-menu-code,
        .episode-menu-row.active .episode-menu-count {
          color: #aeb6bd;
        }
        .episode-menu-code {
          flex: 0 0 auto;
          min-width: 30px;
          font-size: 10.5px;
          color: var(--ink-dim);
        }
        .episode-menu-title {
          flex: 1;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .episode-menu-count {
          font-size: 10.5px;
          color: var(--ink-dimmer);
        }
        .episode-menu-rename {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          visibility: hidden;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          padding: 2px 7px;
          color: var(--ink-dim);
        }
        .episode-menu-row:hover .episode-menu-rename,
        .episode-menu-rename:focus-visible {
          visibility: visible;
        }
        .episode-menu-rename:hover {
          color: var(--ink);
        }
        .episode-menu-rename:active {
          box-shadow: var(--bevel-in);
        }
        .episode-menu-row.renaming {
          gap: 7px;
          align-items: center;
          padding: 5px 8px 5px 12px;
        }
        .episode-menu-rename-input {
          flex: 1;
          min-width: 0;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          color: var(--ink);
          padding: 4px 8px;
          font-size: 12px;
        }
        .episode-menu-rename-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .episode-menu-suggest,
        .episode-menu-save {
          flex: 0 0 auto;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          padding: 3px 8px;
          color: var(--ink-dim);
        }
        .episode-menu-suggest:hover:not(:disabled),
        .episode-menu-save:hover:not(:disabled) {
          color: var(--ink);
        }
        .episode-menu-suggest:active:not(:disabled),
        .episode-menu-save:active:not(:disabled) {
          box-shadow: var(--bevel-in);
        }
        .episode-menu-suggest:disabled {
          color: var(--ink-faint);
        }
        .episode-menu-suggest-note {
          flex: 0 0 auto;
          font-size: 10px;
          color: var(--ink-dimmer);
        }
        .episode-menu-foot {
          flex: 0 0 auto;
          display: flex;
        }
        .episode-menu-new {
          flex: 1;
          background: var(--ground-raised);
          border: none;
          box-shadow: var(--bevel-out);
          padding: 7px 10px;
          color: var(--ink-dim);
        }
        .episode-menu-new:hover {
          color: var(--ink);
        }
        .episode-menu-add-input {
          flex: 1;
          background: #fff;
          border: none;
          box-shadow: var(--bevel-in);
          color: var(--ink);
          padding: 7px 12px;
          font-size: 12px;
        }
        .episode-menu-add-input:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .episode-menu-add-input::placeholder {
          color: var(--ink-faint);
        }
      `}</style>
    </div>
  );
}
