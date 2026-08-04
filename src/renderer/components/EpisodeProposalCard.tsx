import { useEffect, useState } from "react";
import type { EpisodeProposal } from "../../shared/types";

interface EpisodeProposalCardProps {
  proposal: EpisodeProposal;
  /** Applies the accepted rows. Codes are already trimmed. */
  onApply: (rows: Array<{ code: string; sourceProject: string; title?: string | null }>) => Promise<void>;
  onDismiss: () => void;
  /** Re-reads the proposal while tag reads are still running. */
  onRefresh?: () => void;
}

function clipCount(count: number): string {
  return `${count} ${count === 1 ? "clip" : "clips"}`;
}

/**
 * The proposal Dailies makes after reading Avid project tags out of the media:
 * one row per distinct project name, with the suggested episode code editable
 * before anything is created. Rows whose project already has an episode are
 * shown but cannot be created twice.
 */
export function EpisodeProposalCard({ proposal, onApply, onDismiss, onRefresh }: EpisodeProposalCardProps) {
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suggested codes come from main and can change as more tags are read.
  // An edited code wins; a row that has not been touched follows the suggestion.
  useEffect(() => {
    setCodes((current) => {
      const next: Record<string, string> = {};
      for (const row of proposal.rows) {
        next[row.sourceProject] = current[row.sourceProject] ?? row.code;
      }
      return next;
    });
  }, [proposal]);

  const selectable = proposal.rows.filter((row) => !row.alreadyExists);
  const accepted = selectable.filter((row) => !skipped.has(row.sourceProject));
  const ready = accepted.filter((row) => (codes[row.sourceProject] ?? row.code).trim().length > 0);

  function toggle(sourceProject: string) {
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(sourceProject)) next.delete(sourceProject);
      else next.add(sourceProject);
      return next;
    });
  }

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      await onApply(
        ready.map((row) => ({
          sourceProject: row.sourceProject,
          code: (codes[row.sourceProject] ?? row.code).trim(),
          title: row.title,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the episodes.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="proposal-card">
      <div className="proposal-bar">
        <span className="proposal-bar-title label">Episodes from media</span>
        <span className="proposal-bar-stripes" aria-hidden="true" />
      </div>

      <div className="proposal-body">
        <p className="proposal-lede">
          Avid wrote a project name into this media. Each name below can become an episode.
        </p>

        <table className="proposal-table">
          <thead>
            <tr>
              <th className="label proposal-col-use">Use</th>
              <th className="label">Avid project</th>
              <th className="label proposal-col-count">Clips</th>
              <th className="label proposal-col-code">Episode code</th>
            </tr>
          </thead>
          <tbody>
            {proposal.rows.map((row) => {
              const off = row.alreadyExists || skipped.has(row.sourceProject);
              return (
                <tr key={row.sourceProject} className={off ? "proposal-row off" : "proposal-row"}>
                  <td className="proposal-col-use">
                    <input
                      type="checkbox"
                      checked={!off}
                      disabled={row.alreadyExists || applying}
                      onChange={() => toggle(row.sourceProject)}
                      aria-label={`Create an episode for ${row.sourceProject}`}
                    />
                  </td>
                  <td className="mono proposal-project">{row.sourceProject}</td>
                  <td className="mono proposal-col-count">{row.clipCount}</td>
                  <td className="proposal-col-code">
                    {row.alreadyExists ? (
                      <span className="proposal-note">Already an episode</span>
                    ) : (
                      <input
                        className="proposal-code mono"
                        value={codes[row.sourceProject] ?? row.code}
                        disabled={off || applying}
                        onChange={(e) =>
                          setCodes((current) => ({ ...current, [row.sourceProject]: e.target.value }))
                        }
                        aria-label={`Episode code for ${row.sourceProject}`}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {proposal.untaggedClipCount > 0 && (
          <p className="proposal-note mono">
            {clipCount(proposal.untaggedClipCount)} {proposal.untaggedClipCount === 1 ? "has" : "have"} no
            project tag. {proposal.untaggedClipCount === 1 ? "It stays" : "They stay"} out of these episodes.
          </p>
        )}
        {proposal.pendingClipCount > 0 && (
          <p className="proposal-note mono">
            Still reading tags on {clipCount(proposal.pendingClipCount)}.{" "}
            {onRefresh && (
              <button type="button" className="proposal-inline-action" onClick={onRefresh}>
                Check again
              </button>
            )}
          </p>
        )}
        {error && <p className="proposal-error mono">{error}</p>}

        <div className="proposal-actions">
          <button
            type="button"
            className="proposal-primary label"
            onClick={() => void apply()}
            disabled={ready.length === 0 || applying}
          >
            {applying
              ? "Creating…"
              : `Create ${ready.length} ${ready.length === 1 ? "episode" : "episodes"}`}
          </button>
          <button type="button" className="ghost-btn label" onClick={onDismiss} disabled={applying}>
            Not now
          </button>
        </div>
      </div>

      <style>{`
        .proposal-card {
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          margin: 0 0 18px;
          max-width: 640px;
        }
        .proposal-bar {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 7px 12px;
          box-shadow: inset 0 -1px 0 var(--chrome-lo);
          user-select: none;
        }
        .proposal-bar-title {
          margin: 0;
        }
        .proposal-bar-stripes {
          flex: 1;
          height: 8px;
          background: repeating-linear-gradient(0deg, var(--chrome-lo) 0 1px, transparent 1px 3px);
          opacity: 0.5;
        }
        .proposal-body {
          padding: 14px 16px 16px;
        }
        .proposal-lede {
          margin: 0 0 12px;
          font-size: 13px;
          color: var(--ink-dim);
        }
        .proposal-table {
          width: 100%;
          border-collapse: collapse;
          background: var(--ground-card);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
        }
        .proposal-table th {
          text-align: left;
          padding: 6px 10px;
          color: var(--ink-dimmer);
          border-bottom: 1px solid var(--hairline);
          white-space: nowrap;
        }
        .proposal-table td {
          padding: 5px 10px;
          font-size: 12px;
          color: var(--ink);
          vertical-align: middle;
        }
        .proposal-row:nth-child(even) td {
          background: var(--paper-alt);
        }
        .proposal-row.off td {
          color: var(--ink-faint);
        }
        .proposal-col-use {
          width: 34px;
        }
        .proposal-col-count {
          width: 56px;
          text-align: right;
        }
        .proposal-col-code {
          width: 40%;
        }
        .proposal-project {
          word-break: break-all;
        }
        .proposal-code {
          width: 100%;
          max-width: 180px;
          background: #fff;
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          color: var(--ink);
          padding: 4px 8px;
          font-size: 12px;
        }
        .proposal-code:focus {
          outline: 2px solid var(--accent);
          outline-offset: -1px;
        }
        .proposal-code:disabled {
          background: var(--paper-alt);
          color: var(--ink-faint);
        }
        .proposal-note {
          margin: 10px 0 0;
          font-size: 11px;
          color: var(--ink-dimmer);
        }
        .proposal-inline-action {
          background: none;
          border: none;
          padding: 0;
          font: inherit;
          color: var(--accent);
          text-decoration: underline;
          cursor: pointer;
        }
        .proposal-error {
          margin: 10px 0 0;
          font-size: 11px;
          color: var(--status-error);
        }
        .proposal-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 14px;
        }
        .proposal-primary {
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: #fff;
          padding: 6px 14px;
          font-size: 11px;
        }
        .proposal-primary:active {
          background: var(--marker-red-dn);
          box-shadow: var(--bevel-in);
        }
        .proposal-primary:disabled {
          background: var(--ground-raised);
          border-color: var(--chrome-lo);
          color: var(--ink-faint);
        }
        @media (max-width: 720px) {
          .proposal-col-code {
            width: auto;
          }
          .proposal-table th,
          .proposal-table td {
            padding: 5px 6px;
          }
        }
      `}</style>
    </div>
  );
}
