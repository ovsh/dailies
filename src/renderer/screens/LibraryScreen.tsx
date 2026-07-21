import { useCallback, useEffect, useRef, useState } from "react";
import { api, mediaUrl } from "../api";
import type { Episode, MediaFile, MediaRole, ProjectFolder } from "../../shared/types";
import { ClipCard } from "../components/ClipCard";
import { EpisodeBar } from "../components/EpisodeBar";
import { Toast } from "../components/Toast";
import { InlineError } from "../components/InlineError";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { runIpc } from "../lib/async";

interface LibraryScreenProps {
  onOpenClip: (fileId: number) => void;
  episodeId: number | null;
  episodes: Episode[];
  folders: ProjectFolder[];
  onEpisodeChange: (id: number | null) => void;
  onCreateEpisode: (code: string) => Promise<void>;
  onRefresh: () => Promise<unknown>;
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
  episodeId,
  episodes,
  folders,
  onEpisodeChange,
  onCreateEpisode,
  onRefresh,
}: LibraryScreenProps) {
  const [files, setFiles] = useState<MediaFile[] | null>(null);
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
  const keyframesRef = useRef<Record<number, string | null>>({});
  const detailSignaturesRef = useRef<Record<number, string>>({});

  const load = useCallback(async () => {
    await runIpc(
      async () => {
        const f = await api.listFiles(episodeId ?? undefined);
        setFiles(f);

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
  const visibleFiles = files?.filter((f) => roleFilter === "all" || f.role === roleFilter) ?? null;

  const scopedFolders = episodeId === null ? folders : folders.filter((f) => f.episodeId === episodeId);
  const scanTimes = scopedFolders.map((f) => f.lastScannedAt).filter((t): t is string => t !== null);
  const latestScan = scanTimes.length > 0 ? scanTimes.sort().at(-1)! : null;

  return (
    <div className="library-screen">
      <header className="library-header">
        <div className="library-header-row">
          <div>
            <span className="label">Library</span>
            <h1 className="display">Footage</h1>
            {files && files.length > 0 && <p className="library-count mono">{files.length} clips</p>}
          </div>
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
            <>Scanned {formatScanTime(latestScan)} — </>
          ) : (
            <>Not scanned yet — </>
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
      </header>

      <div className="library-scroll">
        {!files && loading && <p className="library-loading mono">Loading…</p>}
        {loadError && <InlineError message={loadError} onRetry={() => void load()} retrying={loading} />}

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
              <ClipCard
                key={f.id}
                file={f}
                keyframe={mediaUrl(keyframes[f.id]) ?? null}
                onOpen={() => onOpenClip(f.id)}
                onRetry={() => void handleRetryFile(f.id)}
                retrying={retryingFileIds.has(f.id)}
              />
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
          padding: 44px 48px 20px;
          border-bottom: 1px solid var(--hairline);
          flex: 0 0 auto;
        }
        .library-header-row {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 24px;
        }
        .library-header h1 {
          font-size: 28px;
          margin: 6px 0 8px;
          color: var(--ink);
        }
        .library-count {
          font-size: 11px;
          color: var(--ink-dimmer);
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
          background: transparent;
          border: 1px solid var(--hairline-strong);
          border-radius: 6px;
          color: var(--ink-dimmer);
          padding: 5px 11px;
          transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
        }
        .library-filter-chip:hover {
          color: var(--ink-dim);
        }
        .library-filter-chip.active {
          color: var(--accent);
          border-color: var(--accent-dim);
        }
        .library-scan-line {
          margin: 16px 0 0;
          font-size: 11px;
          color: var(--ink-faint);
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
          padding: 32px 48px 48px;
        }
        .library-loading {
          color: var(--ink-dimmer);
          font-size: 12px;
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
      `}</style>
    </div>
  );
}
