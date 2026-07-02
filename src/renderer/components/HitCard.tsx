import type { AnswerHit } from "../../shared/types";
import { TimecodeText } from "./TimecodeText";

interface HitCardProps {
  hit: AnswerHit;
  index: number;
  onOpen: (hit: AnswerHit) => void;
  selected?: boolean;
  onToggleSelect?: (hit: AnswerHit) => void;
}

const CONFIDENCE_COLOR: Record<AnswerHit["confidence"], string> = {
  high: "var(--accent)",
  medium: "var(--ink-dim)",
  low: "var(--ink-faint)",
};

export function HitCard({ hit, index, onOpen, selected, onToggleSelect }: HitCardProps) {
  return (
    <div className="hit-card" style={{ animationDelay: `${index * 70}ms` }}>
      <button className="hit-thumb" onClick={() => onOpen(hit)} aria-label={`Open ${hit.filename} at ${hit.inTc}`}>
        {hit.keyframePath ? (
          <img src={hit.keyframePath} alt="" loading="lazy" />
        ) : (
          <div className="hit-thumb-empty" />
        )}
        <span className="hit-kind label">{hit.kind === "spoken" ? "SAID" : "SEEN"}</span>
      </button>

      <div className="hit-body">
        <div className="hit-row">
          <span className="hit-filename mono" title={hit.filename}>
            {hit.filename}
          </span>
          {onToggleSelect && (
            <input
              type="checkbox"
              className="hit-select"
              checked={!!selected}
              onChange={() => onToggleSelect(hit)}
              aria-label="Select for export"
            />
          )}
        </div>

        <div className="hit-row">
          <TimecodeText tc={hit.inTc} />
          <span className="hit-dash mono">—</span>
          <TimecodeText tc={hit.outTc} />
          <span className="hit-conf" title={`Confidence: ${hit.confidence}`}>
            <span className="hit-conf-dot" style={{ background: CONFIDENCE_COLOR[hit.confidence] }} />
          </span>
        </div>

        {hit.quote && <p className="hit-quote">&ldquo;{hit.quote}&rdquo;</p>}
        {hit.description && <p className="hit-desc">{hit.description}</p>}
      </div>

      <style>{`
        .hit-card {
          display: flex;
          flex-direction: column;
          background: var(--ground-card);
          border: 1px solid var(--hairline);
          border-radius: 10px;
          overflow: hidden;
          animation: fade-up var(--dur-med) var(--ease-out) both;
          box-shadow: var(--shadow-card);
        }
        .hit-thumb {
          position: relative;
          display: block;
          width: 100%;
          aspect-ratio: 16 / 9;
          padding: 0;
          border: none;
          background: var(--ground);
          cursor: pointer;
        }
        .hit-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          filter: saturate(0.85) brightness(0.9);
          transition: filter var(--dur-med) var(--ease-out);
        }
        .hit-thumb:hover img {
          filter: saturate(1) brightness(1);
        }
        .hit-thumb-empty {
          width: 100%;
          height: 100%;
          background: var(--ground-raised);
        }
        .hit-kind {
          position: absolute;
          top: 8px;
          left: 8px;
          background: rgba(19, 17, 22, 0.78);
          border: 1px solid var(--hairline-strong);
          color: var(--ink-dim);
          padding: 3px 7px;
          border-radius: 4px;
          font-size: 9.5px;
        }
        .hit-body {
          padding: 12px 14px 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .hit-row {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .hit-filename {
          font-size: 11px;
          color: var(--ink-dim);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .hit-select {
          accent-color: var(--accent);
          width: 13px;
          height: 13px;
          flex: 0 0 auto;
        }
        .hit-dash {
          color: var(--ink-faint);
          font-size: 11px;
        }
        .hit-conf {
          margin-left: auto;
          display: flex;
          align-items: center;
        }
        .hit-conf-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
        }
        .hit-quote {
          font-family: var(--font-display);
          font-style: italic;
          font-size: 15px;
          line-height: 1.5;
          color: var(--ink);
          margin: 2px 0 0;
        }
        .hit-desc {
          font-size: 12.5px;
          line-height: 1.55;
          color: var(--ink-dim);
          margin: 2px 0 0;
        }
      `}</style>
    </div>
  );
}
