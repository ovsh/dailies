import type { MediaFile } from "../../shared/types";
import { TimecodeText } from "./TimecodeText";
import { AudioGlyph } from "./AudioGlyph";
import { isAudioOnly } from "../lib/media";

interface ClipCardProps {
  file: MediaFile;
  keyframe: string | null;
  onOpen: (file: MediaFile) => void;
  onRetry: (file: MediaFile) => void;
  retrying: boolean;
}

function formatDuration(durationS: number): string {
  const s = Math.round(durationS);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/** Minimal SVG glyphs, no emoji. */
function TranscriptGlyph({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ opacity: active ? 1 : 0.3 }}>
      <rect x="5" y="2" width="6" height="8" rx="3" />
      <path d="M3 8a5 5 0 0 0 10 0" />
      <path d="M8 13v1.5" />
    </svg>
  );
}

export function ClipCard({ file, keyframe, onOpen, onRetry, retrying }: ClipCardProps) {
  const audioOnly = isAudioOnly(file);

  return (
    <div className="clip-card-shell">
      <button type="button" className="clip-card" onClick={() => onOpen(file)}>
        <div className="clip-thumb">
          {audioOnly ? (
            <div className="clip-thumb-audio">
              <AudioGlyph size={36} />
              <span className="label">Audio</span>
            </div>
          ) : keyframe ? (
            <img src={keyframe} alt="" loading="lazy" />
          ) : (
            <div className="clip-thumb-empty" />
          )}
          {file.status !== "ready" && <span className="clip-status label">{file.status}</span>}
          {file.role === "final" && <span className="clip-final-tag label">FINAL</span>}
        </div>
        <div className="clip-meta">
          <span className="clip-filename mono">{file.clipName ?? file.filename}</span>
          <div className="clip-meta-row">
            <TimecodeText tc={file.startTc} dim />
            <span className="clip-dur mono">{formatDuration(file.durationS)}</span>
            <span className="clip-glyphs">
              <TranscriptGlyph active={file.hasTranscript} />
            </span>
          </div>
        </div>
      </button>
      {file.status === "error" && (
        <button
          type="button"
          className="clip-retry label"
          onClick={() => onRetry(file)}
          disabled={retrying}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
      <style>{`
        .clip-card-shell {
          position: relative;
          min-width: 0;
        }
        .clip-card {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          overflow: hidden;
          text-align: left;
          padding: 4px;
        }
        .clip-card-shell:hover .clip-card {
          border-color: var(--panel-border);
          box-shadow: var(--bevel-out), var(--shadow-card);
        }
        .clip-thumb {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          background: var(--bezel);
          border: 1px solid var(--panel-border);
        }
        .clip-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .clip-thumb-empty {
          width: 100%;
          height: 100%;
          background: var(--bezel);
        }
        .clip-thumb-audio {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 9px;
          color: var(--bezel-ink);
          background: var(--bezel);
        }
        .clip-thumb-audio .label {
          color: var(--bezel-ink);
          font-size: 9px;
        }
        .clip-status {
          position: absolute;
          top: 8px;
          right: 8px;
          background: var(--ground-card);
          border: 1px solid var(--status-warn);
          color: var(--status-warn);
          padding: 3px 7px;
          border-radius: 2px;
        }
        .clip-final-tag {
          position: absolute;
          top: 8px;
          left: 8px;
          background: var(--select-bg);
          border: 1px solid var(--select-bg);
          color: var(--select-ink);
          padding: 3px 7px;
          border-radius: 2px;
        }
        .clip-retry {
          position: absolute;
          top: 36px;
          right: 8px;
          z-index: 1;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-out);
          color: var(--ink);
          padding: 3px 7px;
          border-radius: 2px;
          font-size: 9px;
        }
        .clip-retry:hover:not(:disabled) {
          background: #d2d6d9;
        }
        .clip-retry:active:not(:disabled) {
          box-shadow: var(--bevel-in);
        }
        .clip-retry:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
        .clip-meta {
          padding: 8px 8px 6px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .clip-filename {
          font-size: 11px;
          color: var(--ink);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .clip-meta-row {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 11px;
        }
        .clip-dur {
          color: var(--ink-dim);
        }
        .clip-glyphs {
          margin-left: auto;
          display: flex;
          gap: 7px;
          color: var(--ink-dim);
        }
      `}</style>
    </div>
  );
}
