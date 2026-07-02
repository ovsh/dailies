import { useEffect, useState } from "react";
import { api } from "../api";
import type { MediaFile } from "../../shared/types";
import { ClipCard } from "../components/ClipCard";
import { getScenes } from "../mock/data";

interface LibraryScreenProps {
  onOpenClip: (fileId: number) => void;
}

export function LibraryScreen({ onOpenClip }: LibraryScreenProps) {
  const [files, setFiles] = useState<MediaFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listFiles().then((f) => {
      if (!cancelled) setFiles(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="library-screen">
      <header className="library-header">
        <span className="label">Library</span>
        <h1 className="display">Footage</h1>
        {files && <p className="library-count mono">{files.length} clips</p>}
      </header>

      <div className="library-scroll">
        {!files && <p className="library-loading mono">Loading…</p>}
        {files && (
          <div className="library-grid">
            {files.map((f) => (
              <ClipCard key={f.id} file={f} keyframe={getScenes(f.id)[0]?.keyframePath ?? null} onOpen={() => onOpenClip(f.id)} />
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
        .library-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          gap: 18px;
        }
      `}</style>
    </div>
  );
}
