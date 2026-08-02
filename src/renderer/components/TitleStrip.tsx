interface TitleStripProps {
  /** Full project name, e.g. "DUCK DYNASTY" — rendered as an initials tile. */
  projectName: string;
  onOpenProjects: () => void;
  railExpanded: boolean;
  onToggleRail: () => void;
}

function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * The window's title row: a 48px chrome strip that owns the macOS traffic
 * lights (left padding 84px clears them at any rail width), the rail toggle,
 * and the project switcher. On macOS it is also the window drag region.
 */
export function TitleStrip({ projectName, onOpenProjects, railExpanded, onToggleRail }: TitleStripProps) {
  const toggleLabel = railExpanded ? "Hide sidebar" : "Show sidebar";
  return (
    <header className="tstrip">
      <button
        className={`tstrip-btn tstrip-toggle${railExpanded ? " on" : ""}`}
        onClick={onToggleRail}
        aria-pressed={railExpanded}
        aria-label={toggleLabel}
        title={`${toggleLabel}  ⌘\\`}
      >
        <svg viewBox="0 0 15 11" aria-hidden="true">
          <rect className="fr" x=".6" y=".6" width="13.8" height="9.8" />
          <rect className="col" x="1.4" y="1.4" width="3.4" height="8.2" />
        </svg>
      </button>
      <span className="tstrip-sep" aria-hidden="true" />
      <button
        className="tstrip-btn tstrip-project"
        onClick={onOpenProjects}
        aria-label={`${projectName} — switch project`}
        title={`${projectName} — switch project`}
      >
        <span className="tstrip-tile mono">{projectInitials(projectName)}</span>
        <svg className="tstrip-caret" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M1 2.6h6L4 6.4z" />
        </svg>
      </button>
      <span className="tstrip-drag" aria-hidden="true" />
      <style>{`
        .tstrip {
          height: 48px;
          flex: 0 0 48px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 10px 0 84px;
          background: var(--ground-raised);
          background-image: repeating-linear-gradient(180deg, rgba(23,25,27,.055) 0 1px, transparent 1px 3px);
          border-bottom: 1px solid var(--panel-border);
          box-shadow: var(--bevel-out);
          position: relative;
          z-index: 20;
          user-select: none;
          -webkit-app-region: drag;
          app-region: drag;
        }
        /* Windows keeps its native title bar: no lights to clear, no drag duty. */
        .platform-win32 .tstrip {
          padding-left: 12px;
          -webkit-app-region: no-drag;
          app-region: no-drag;
        }
        .tstrip-btn {
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: var(--ink);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .tstrip-btn:hover {
          background: #d2d6d9;
        }
        .tstrip-btn:active {
          box-shadow: var(--bevel-in);
        }
        .tstrip-toggle {
          width: 28px;
          height: 24px;
          flex: 0 0 28px;
        }
        .tstrip-toggle svg {
          width: 15px;
          height: 11px;
        }
        .tstrip-toggle .fr {
          fill: none;
          stroke: var(--ink-dim);
          stroke-width: 1.2;
        }
        .tstrip-toggle .col {
          fill: none;
          stroke: var(--ink-faint);
          stroke-width: 1.2;
          stroke-dasharray: 1.6 1.6;
        }
        .tstrip-toggle.on .col {
          fill: var(--ink);
          stroke: none;
        }
        .tstrip-sep {
          width: 1px;
          height: 20px;
          flex: none;
          background: var(--chrome-lo);
          box-shadow: 1px 0 0 var(--chrome-hi);
        }
        .tstrip-project {
          height: 24px;
          padding: 0 6px;
          gap: 6px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.03em;
        }
        .tstrip-tile {
          width: 16px;
          height: 16px;
          flex: 0 0 16px;
          background: var(--select-bg);
          color: var(--select-ink);
          font-size: 9px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .tstrip-caret {
          width: 7px;
          height: 7px;
          flex: 0 0 7px;
        }
        .tstrip-caret path {
          fill: var(--ink-dim);
        }
        .tstrip-drag {
          flex: 1;
          align-self: stretch;
        }
      `}</style>
    </header>
  );
}
