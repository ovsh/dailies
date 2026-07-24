import type { AnswerHit } from "../../shared/types";
import { mediaUrl } from "../api";
import { TimecodeText } from "./TimecodeText";

interface HitCardProps {
  hit: AnswerHit;
  index: number;
  onOpen: (hit: AnswerHit) => void;
  selected?: boolean;
  onToggleSelect?: (hit: AnswerHit) => void;
}

const CONFIDENCE_COLOR: Record<AnswerHit["confidence"], string> = {
  high: "var(--status-ok)",
  medium: "var(--status-warn)",
  low: "var(--ink-faint)",
};

export function HitCard({ hit, index, onOpen, selected, onToggleSelect }: HitCardProps) {
  return (
    <div className="hit-card" style={{ animationDelay: `${index * 70}ms` }}>
      <button className="hit-thumb" onClick={() => onOpen(hit)} aria-label={`Open ${hit.filename} at ${hit.inTc}`}>
        {hit.keyframePath ? (
          <img src={mediaUrl(hit.keyframePath)} alt="" loading="lazy" />
        ) : (
          <div className="hit-thumb-empty" />
        )}
        <span className="hit-kind-group">
          <span className="hit-kind label">{hit.kind === "spoken" ? "SAID" : "SEEN"}</span>
          {hit.role === "final" && <span className="hit-final-tag label">FINAL</span>}
        </span>
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
          <span className="hit-dash mono">-</span>
          <TimecodeText tc={hit.outTc} />
          <span className="hit-conf" title={`Confidence: ${hit.confidence}`}>
            <span className="hit-conf-dot" style={{ background: CONFIDENCE_COLOR[hit.confidence] }} />
          </span>
        </div>

        {hit.quote && <p className="hit-quote mono">"{hit.quote}"</p>}
        {hit.description && <p className="hit-desc">{hit.description}</p>}
      </div>

      <style>{`
        .hit-card {
          display: flex;
          flex-direction: column;
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out), var(--shadow-card);
          overflow: hidden;
          animation: fade-up var(--dur-med) var(--ease-out) both;
          padding: 4px;
        }
        .hit-thumb {
          position: relative;
          display: block;
          width: 100%;
          aspect-ratio: 16 / 9;
          padding: 0;
          border: 1px solid var(--panel-border);
          background: var(--bezel);
          cursor: pointer;
        }
        .hit-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .hit-thumb-empty {
          width: 100%;
          height: 100%;
          background: var(--bezel);
        }
        .hit-kind-group {
          position: absolute;
          top: 8px;
          left: 8px;
          display: flex;
          gap: 6px;
        }
        .hit-kind {
          background: var(--ground-card);
          border: 1px solid var(--panel-border);
          color: var(--ink);
          padding: 3px 7px;
          border-radius: 2px;
          font-size: 9.5px;
        }
        .hit-final-tag {
          background: var(--select-bg);
          border: 1px solid var(--select-bg);
          color: var(--select-ink);
          padding: 3px 7px;
          border-radius: 2px;
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
          color: var(--ink);
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
          font-size: 12.5px;
          line-height: 1.55;
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
