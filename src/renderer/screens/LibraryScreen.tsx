import { useCallback, useEffect, useRef, useState } from "react";
import { api, mediaUrl } from "../api";
import type {
  Episode,
  MediaFile,
  MediaRole,
  PipelineSnapshot,
  ProjectFolder,
} from "../../shared/types";
import { ClipCard } from "../components/ClipCard";
import { EpisodeBar } from "../components/EpisodeBar";
import { Toast } from "../components/Toast";
import { InlineError } from "../components/InlineError";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { runIpc } from "../lib/async";

/** One request to bring a specific card into view and focus, e.g. from Chat's "Open in library". */
export interface LibraryFocusRequest {
  fileId: number;
  requestId: number;
}

interface LibraryScreenProps {
  onOpenClip: (fileId: number) => void;
  focusRequest?: LibraryFocusRequest | null;
  episodeId: number | null;
  episodes: Episode[];
  folders: ProjectFolder[];
  onEpisodeChange: (id: number | null) => void;
  onCreateEpisode: (code: string) => Promise<void>;
  onRefresh: () => Promise<unknown>;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

type RoleFilter = "all" | MediaRole;

function formatScanTime(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hh}:${mm}`;
}

export function LibraryScreen({
  onOpenClip,
  focusRequest,
  episodeId,
  episodes,
  folders,
  onEpisodeChange,
  onCreateEpisode,
  onRefresh,
}: LibraryScreenProps) {
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const [pipelineSnapshot, setPipelineSnapshot] = useState<PipelineSnapshot | null>(null);
  const [keyframes, setKeyframes] = useState<Record<number, string | null>>({});
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [retryingFileIds, setRetryingFileIds] = useState<Set<number>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [focusedFileId, setFocusedFileId] = useState<number | null>(null);
  const [focusNotice, setFocusNotice] = useState<string | null>(null);
  const keyframesRef = useRef<Record<number, string | null>>({});
  const detailSignaturesRef = useRef<Record<number, string>>({});
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const handledFocusRequestRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    await runIpc(
      async () => {
        const [f, snapshot] = await Promise.all([
          api.listFiles(episodeId ?? undefined),
          api.getPipelineSnapshot({ episodeId }),
        ]);
        setFiles(f);
        setPipelineSnapshot(snapshot);

        // Detail calls are limited to clips whose indexing signature changed.
        // This keeps frequent job revisions cheap even in large libraries.
        const changed = f.filter((file) => {
          const signature = `${file.status}:${file.proxyPath ?? ""}`;
          return detailSignaturesRef.current[file.id] !== signature;
        });
        const entries = await Promise.all(
          changed.map(async (file) => {
            const signature = `${file.status}:${file.proxyPath ?? ""}`;
            detailSignaturesRef.current[file.id] = signature;
            try {
              const detail = await api.getFileDetail(file.id);
              return [file.id, detail.scenes[0]?.keyframePath ?? null] as const;
            } catch {
              return [file.id, keyframesRef.current[file.id] ?? null] as const;
            }
          }),
        );
        if (entries.length > 0) {
          const next = { ...keyframesRef.current, ...Object.fromEntries(entries) };
          keyframesRef.current = next;
          setKeyframes(next);
        }
      },
      { setPending: setLoading, setError: setLoadError, fallback: "Could not refresh the library." },
    );
  }, [episodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh(load);

  async function addFolder(role: MediaRole) {
    setRetryAction(() => () => void addFolder(role));
    const result = await runIpc(
      async () => {
        const folder = await api.addProjectFolder(role, episodeId);
        if (folder) {
          await onRefresh();
          await load();
        }
        return folder;
      },
      { setPending: setAddingFolder, setError: setActionError, fallback: "Could not add that folder." },
    );
    if (result.ok) {
      setRetryAction(null);
    }
  }

  async function handleImport() {
    setRetryAction(() => () => void handleImport());
    const result = await runIpc(
      () => api.importDocuments(episodeId),
      { setPending: setImporting, setError: setActionError, fallback: "Could not import documents." },
    );
    if (result.ok) {
      setRetryAction(null);
      setToast(`${result.value} ${result.value === 1 ? "document" : "documents"} imported`);
    }
  }

  async function handleRescan() {
    setRetryAction(() => () => void handleRescan());
    const result = await runIpc(
      async () => {
        await api.rescanFolders(episodeId);
        await onRefresh();
        await load();
      },
      { setPending: setScanning, setError: setActionError, fallback: "Could not rescan watched folders." },
    );
    if (result.ok) setRetryAction(null);
  }

  async function handleRetryFile(fileId: number) {
    setRetryAction(() => () => void handleRetryFile(fileId));
    const result = await runIpc(
      async () => {
        await api.retryFile(fileId);
        await Promise.all([load(), onRefresh()]);
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

  const isEmpty = files !== null && files.length === 0;
  const visibleFiles =
    files?.filter((f) => roleFilter === "all" || f.locations.some((loc) => loc.role === roleFilter)) ?? null;

  // A request from Chat's "Open in library" may arrive before the target file's
  // role is visible under the current filter, or before the grid has rendered
  // it at all — retry every render until the wrapper ref actually exists.
  useEffect(() => {
    if (!focusRequest || handledFocusRequestRef.current === focusRequest.requestId || !files) return;
    const match = files.find((f) => f.id === focusRequest.fileId);
    if (!match) {
      handledFocusRequestRef.current = focusRequest.requestId;
      setFocusNotice("Clip is no longer in the library");
      return;
    }
    setFocusNotice(null);
    if (roleFilter !== "all" && match.role !== roleFilter) {
      setRoleFilter("all");
      return;
    }
    const wrapper = cardRefs.current.get(focusRequest.fileId);
    if (!wrapper) return;
    handledFocusRequestRef.current = focusRequest.requestId;
    setFocusedFileId(focusRequest.fileId);
    wrapper.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    wrapper.querySelector<HTMLButtonElement>(".clip-card")?.focus();
  }, [focusRequest, files, roleFilter]);

  const scopedFolders = episodeId === null ? folders : folders.filter((f) => f.episodeId === episodeId);
  const scanTimes = scopedFolders.map((f) => f.lastScannedAt).filter((t): t is string => t !== null);
  const latestScan = scanTimes.length > 0 ? scanTimes.sort().at(-1)! : null;
  const pendingFileIds = new Set(pipelineSnapshot?.pendingFileIds ?? []);
  const failedFileIds = new Set(
    pipelineSnapshot?.failures.map((failure) => failure.fileId) ?? [],
  );

  return (
    <div className="library-screen">
      <header className="library-header">
        <div className="library-bar">
          <span className="library-bar-close" aria-hidden="true" />
          <span className="library-bar-title label">Library</span>
          <span className="library-bar-stripes" aria-hidden="true" />
          {files && files.length > 0 && <span className="library-bar-meta mono">{files.length} clips</span>}
        </div>

        <div className="library-header-body">
          <div className="library-header-row">
            <h1 className="display">Footage</h1>
            <div className="library-header-btns">
              <button className="ghost-btn label" onClick={handleImport} disabled={importing}>
                {importing ? "Importing…" : "Import"}
              </button>
              <button className="ghost-btn label" onClick={() => addFolder("raw")} disabled={addingFolder}>
                Add raw folder…
              </button>
              <button className="ghost-btn label" onClick={() => addFolder("final")} disabled={addingFolder}>
                Add finals…
              </button>
            </div>
          </div>

          <div className="library-scope-row">
            <EpisodeBar
              episodes={episodes}
              activeEpisodeId={episodeId}
              onSelect={onEpisodeChange}
              onCreate={onCreateEpisode}
            />
            {files && files.length > 0 && (
              <div className="library-filters">
                {(["all", "raw", "final"] as RoleFilter[]).map((r) => (
                  <button
                    key={r}
                    className={`library-filter-chip label${roleFilter === r ? " active" : ""}`}
                    onClick={() => setRoleFilter(r)}
                  >
                    {r === "all" ? "ALL" : r === "raw" ? "RAW" : "FINALS"}
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="library-scan-line mono">
            {latestScan ? (
              <>Scanned {formatScanTime(latestScan)} · </>
            ) : (
              <>Not scanned yet · </>
            )}
            <button className="library-scan-action" onClick={handleRescan} disabled={scanning}>
              {scanning ? "Scanning…" : latestScan ? "Scan again" : "Scan now"}
            </button>
          </p>
          {actionError && (
            <InlineError
              message={actionError}
              onRetry={retryAction ?? undefined}
              retrying={importing || scanning || addingFolder || retryingFileIds.size > 0}
            />
          )}
        </div>
      </header>

      <div className="library-scroll">
        {!files && loading && <p className="library-loading mono">Loading…</p>}
        {loadError && <InlineError message={loadError} onRetry={() => void load()} retrying={loading} />}
        {focusNotice && <p className="library-focus-notice mono">{focusNotice}</p>}

        {isEmpty && (
          <div className="library-empty">
            <p className="display library-empty-line">Nothing here yet.</p>
            <p className="library-empty-sub">
              Point Dailies at a footage folder. Clips are indexed in place and transcribed,
              and new files are picked up automatically.
            </p>
            <div className="library-header-btns">
              <button className="ghost-btn label" onClick={() => addFolder("raw")} disabled={addingFolder}>
                Add raw folder…
              </button>
              <button className="ghost-btn label" onClick={() => addFolder("final")} disabled={addingFolder}>
                Add finals…
              </button>
            </div>
          </div>
        )}

        {visibleFiles && visibleFiles.length > 0 && (
          <div className="library-grid">
            {visibleFiles.map((f) => (
              <div
                key={f.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(f.id, el);
                  else cardRefs.current.delete(f.id);
                }}
                className={`clip-focus-wrap${focusedFileId === f.id ? " selected" : ""}`}
              >
                <ClipCard
                  file={f}
                  keyframe={mediaUrl(keyframes[f.id]) ?? null}
                  onOpen={() => {
                    setFocusedFileId(f.id);
                    onOpenClip(f.id);
                  }}
                  onRetry={() => void handleRetryFile(f.id)}
                  retrying={retryingFileIds.has(f.id)}
                  finishing={pendingFileIds.has(f.id)}
                  pipelineFailed={failedFileIds.has(f.id)}
                />
                {f.locations.length > 1 && (
                  <span className="clip-locations mono">{f.locations.length} locations</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      <style>{`
        .library-screen {
          height: 100%;
          display: flex;
          flex-direction: column;
        }
        .library-header {
          background: var(--ground-raised);
          border-bottom: 1px solid var(--panel-border);
          flex: 0 0 auto;
        }
        .library-bar {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 16px;
          box-shadow: inset 0 -1px 0 var(--chrome-lo);
          user-select: none;
        }
        .library-bar-close {
          width: 11px;
          height: 11px;
          flex: none;
          background: var(--ground-raised);
          box-shadow: var(--bevel-out);
          border: 1px solid var(--chrome-lo);
        }
        .library-bar-title {
          margin: 0;
        }
        .library-bar-stripes {
          flex: 1;
          height: 8px;
          background: repeating-linear-gradient(0deg, var(--chrome-lo) 0 1px, transparent 1px 3px);
          opacity: 0.5;
        }
        .library-bar-meta {
          font-size: 11px;
          color: var(--ink-dimmer);
          white-space: nowrap;
        }
        .library-header-body {
          padding: 22px 48px 20px;
        }
        .library-header-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 24px;
        }
        .library-header-row h1 {
          font-size: 28px;
          margin: 0;
          color: var(--ink);
        }
        .library-header-btns {
          display: flex;
          gap: 10px;
        }
        .library-scope-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-top: 18px;
        }
        .library-filters {
          display: flex;
          gap: 8px;
        }
        .library-filter-chip {
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: var(--ink-dim);
          padding: 5px 11px;
        }
        .library-filter-chip:hover {
          background: #d2d6d9;
        }
        .library-filter-chip.active {
          background: var(--select-bg);
          border-color: var(--select-bg);
          box-shadow: none;
          color: var(--select-ink);
        }
        .library-scan-line {
          margin: 16px 0 0;
          font-size: 11px;
          color: var(--ink-dimmer);
        }
        .library-scan-action {
          background: transparent;
          border: none;
          color: var(--ink-dim);
          padding: 0;
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.02em;
          border-bottom: 1px solid transparent;
          transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
        }
        .library-scan-action:hover:not(:disabled) {
          color: var(--accent);
          border-bottom-color: var(--accent-dim);
        }
        .library-scan-action:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
        .library-scroll {
          flex: 1;
          overflow-y: auto;
          background: var(--ground-card);
          box-shadow: inset 0 2px 0 rgba(23, 25, 27, 0.14);
          padding: 32px 48px 48px;
        }
        .library-loading {
          color: var(--ink-dimmer);
          font-size: 12px;
        }
        .library-focus-notice {
          display: inline-block;
          margin: 0 0 16px;
          padding: 6px 8px;
          background: var(--paper-alt);
          border: 1px solid var(--status-warn);
          color: var(--status-warn);
          font-size: 10.5px;
        }
        .library-empty {
          padding-top: 16vh;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          animation: fade-up var(--dur-med) var(--ease-out) both;
        }
        .library-empty-line {
          font-size: 30px;
          color: var(--ink);
          margin: 0;
        }
        .library-empty-sub {
          font-size: 13px;
          color: var(--ink-dimmer);
          line-height: 1.65;
          max-width: 420px;
          margin: 0 0 8px;
        }
        .library-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          gap: 18px;
        }
        .clip-focus-wrap.selected .clip-card {
          background: var(--select-bg);
          border-color: var(--select-bg);
          box-shadow: var(--shadow-card);
        }
        .clip-focus-wrap.selected .clip-filename,
        .clip-focus-wrap.selected .clip-dur {
          color: var(--select-ink);
        }
        .clip-focus-wrap.selected .clip-glyphs {
          color: var(--select-ink);
          opacity: 0.85;
        }
        .clip-locations {
          display: block;
          margin-top: 4px;
          font-size: 10px;
          letter-spacing: 0.02em;
          color: var(--ink-faint);
        }
      `}</style>
    </div>
  );
}
