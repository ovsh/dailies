import type { MediaFile } from "../../shared/types";
import { TimecodeText } from "./TimecodeText";

interface ClipCardProps {
  file: MediaFile;
  keyframe: string | null;
  onOpen: (file: MediaFile) => void;
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

function VisualGlyph({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ opacity: active ? 1 : 0.3 }}>
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

export function ClipCard({ file, keyframe, onOpen }: ClipCardProps) {
  return (
    <button className="clip-card" onClick={() => onOpen(file)}>
      <div className="clip-thumb">
        {keyframe ? <img src={keyframe} alt="" loading="lazy" /> : <div className="clip-thumb-empty" />}
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
            <VisualGlyph active={file.hasVisualIndex} />
          </span>
        </div>
      </div>
      <style>{`
        .clip-card {
          display: flex;
          flex-direction: column;
          background: var(--ground-card);
          border: 1px solid var(--hairline);
          border-radius: 10px;
          overflow: hidden;
          text-align: left;
          padding: 0;
          transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
        }
        .clip-card:hover {
          border-color: var(--hairline-strong);
          transform: translateY(-1px);
        }
        .clip-thumb {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          background: var(--ground);
        }
        .clip-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          filter: saturate(0.85) brightness(0.9);
          transition: filter var(--dur-med) var(--ease-out);
        }
        .clip-card:hover .clip-thumb img {
          filter: saturate(1) brightness(1);
        }
        .clip-thumb-empty {
          width: 100%;
          height: 100%;
          background: var(--ground-raised);
        }
        .clip-status {
          position: absolute;
          top: 8px;
          right: 8px;
          background: rgba(19, 17, 22, 0.78);
          border: 1px solid var(--hairline-strong);
          color: var(--accent);
          padding: 3px 7px;
          border-radius: 4px;
        }
        .clip-final-tag {
          position: absolute;
          top: 8px;
          left: 8px;
          background: rgba(19, 17, 22, 0.78);
          border: 1px solid var(--hairline-strong);
          color: var(--ink-dimmer);
          padding: 3px 7px;
          border-radius: 4px;
        }
        .clip-meta {
          padding: 10px 12px 12px;
          display: flex;
          flex-direction: column;
          gap: 6px;
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
          color: var(--ink-dimmer);
        }
        .clip-glyphs {
          margin-left: auto;
          display: flex;
          gap: 7px;
          color: var(--ink-dim);
        }
      `}</style>
    </button>
  );
}
