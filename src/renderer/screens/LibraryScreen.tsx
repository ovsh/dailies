import { useCallback, useEffect, useState } from "react";
import { api, mediaUrl } from "../api";
import type { MediaFile } from "../../shared/types";
import { ClipCard } from "../components/ClipCard";

interface LibraryScreenProps {
  onOpenClip: (fileId: number) => void;
}

export function LibraryScreen({ onOpenClip }: LibraryScreenProps) {
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const [keyframes, setKeyframes] = useState<Record<number, string | null>>({});
  const [watching, setWatching] = useState<string | null>(null);

  const load = useCallback(async () => {
    const f = await api.listFiles();
    setFiles(f);
    // First scene keyframe per clip, fetched off the detail call.
    const entries = await Promise.all(
      f.map(async (file) => {
        try {
          const detail = await api.getFileDetail(file.id);
          return [file.id, detail.scenes[0]?.keyframePath ?? null] as const;
        } catch {
          return [file.id, null] as const;
        }
      }),
    );
    setKeyframes(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addFolder() {
    const folder = await api.addWatchedFolder();
    if (folder) {
      setWatching(folder);
      void load();
    }
  }

  const isEmpty = files !== null && files.length === 0;

  return (
    <div className="library-screen">
      <header className="library-header">
        <div className="library-header-row">
          <div>
            <span className="label">Library</span>
            <h1 className="display">Footage</h1>
            {files && files.length > 0 && <p className="library-count mono">{files.length} clips</p>}
          </div>
          <button className="ghost-btn label" onClick={addFolder}>
            Add folder…
          </button>
        </div>
      </header>

      <div className="library-scroll">
        {!files && <p className="library-loading mono">Loading…</p>}

        {isEmpty && (
          <div className="library-empty">
            <p className="display library-empty-line">Nothing here yet.</p>
            <p className="library-empty-sub">
              Point Dailies at a footage folder. Clips are indexed in place — transcribed and
              visually catalogued — and new files are picked up automatically.
            </p>
            <button className="ghost-btn label" onClick={addFolder}>
              Choose a footage folder…
            </button>
            {watching && (
              <p className="library-watching mono">
                Watching {watching} — clips appear here as they're indexed.
              </p>
            )}
          </div>
        )}

        {files && files.length > 0 && (
          <div className="library-grid">
            {files.map((f) => (
              <ClipCard
                key={f.id}
                file={f}
                keyframe={mediaUrl(keyframes[f.id]) ?? null}
                onOpen={() => onOpenClip(f.id)}
              />
            ))}
          </div>
        )}
      </div>

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
        .library-watching {
          font-size: 11px;
          color: var(--ink-dim);
          margin-top: 10px;
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
