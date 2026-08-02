import type { ReactElement } from "react";
import type { Screen } from "../App";

interface RailProps {
  screen: Screen;
  onNavigate: (screen: Screen) => void;
  /** Expanded shows icon + label rows; collapsed is the icon-only strip. */
  expanded: boolean;
  /** The running app's version, e.g. "0.3.3". */
  appVersion: string;
  /** An update has finished downloading and is waiting to install. */
  updateReady: boolean;
  /** The banner (or the panel's "On next quit") has been dismissed for this session. */
  updateDismissed: boolean;
  /** Un-dismisses the banner. */
  onShowUpdate: () => void;
}

const ITEMS: { screen: Screen; label: string; icon: ReactElement }[] = [
  {
    screen: "chat",
    label: "Chat",
    icon: (
      <path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.2 3.4a.5.5 0 0 1-.8-.4V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
    ),
  },
  {
    screen: "library",
    label: "Library",
    icon: (
      <>
        <rect x="3.5" y="4.5" width="7" height="7" rx="0.5" />
        <rect x="13.5" y="4.5" width="7" height="7" rx="0.5" />
        <rect x="3.5" y="14.5" width="7" height="5" rx="0.5" />
        <rect x="13.5" y="14.5" width="7" height="5" rx="0.5" />
      </>
    ),
  },
  {
    screen: "jobs",
    label: "Settings & Jobs",
    icon: (
      <>
        <circle cx="12" cy="12" r="3.1" />
        <path d="M12 2.8v3.1M12 18.1v3.1M2.8 12h3.1M18.1 12h3.1M5.5 5.5l2.2 2.2M16.3 16.3l2.2 2.2M18.5 5.5l-2.2 2.2M7.7 16.3l-2.2 2.2" />
      </>
    ),
  },
];

/**
 * Pure navigation below the title strip. The icon column is 56px in both
 * states, so expanding only reveals labels — nothing slides. State changes
 * snap (DESIGN.md motion rule): no width animation.
 */
export function Rail({
  screen,
  onNavigate,
  expanded,
  appVersion,
  updateReady,
  updateDismissed,
  onShowUpdate,
}: RailProps) {
  const showUpdateDot = updateReady && updateDismissed;
  return (
    <nav className={`rail${expanded ? " expanded" : ""}`}>
      <div className="rail-items">
        {ITEMS.map((item) => (
          <button
            key={item.screen}
            className={`rail-btn${screen === item.screen ? " active" : ""}`}
            onClick={() => onNavigate(item.screen)}
            aria-label={item.label}
            data-tooltip={expanded ? undefined : item.label}
          >
            <span className="rail-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                {item.icon}
              </svg>
            </span>
            <span className="rail-lbl">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="rail-spacer" />
      {appVersion && (
        <div className="rail-foot">
          <button
            className="rail-version-chip mono"
            onClick={onShowUpdate}
            aria-label={showUpdateDot ? `Dailies ${appVersion} — update ready, click to review` : `Dailies ${appVersion}`}
            data-tooltip={showUpdateDot ? "Update ready — click to review" : undefined}
          >
            {appVersion}
            {showUpdateDot && <span className="rail-version-dot" aria-hidden="true" />}
          </button>
        </div>
      )}
      <style>{`
        .rail {
          width: var(--rail-w);
          flex: 0 0 var(--rail-w);
          height: 100%;
          background: var(--ground-raised);
          border-right: 1px solid var(--panel-border);
          box-shadow: var(--bevel-out);
          display: flex;
          flex-direction: column;
          padding: 12px 0 14px;
          overflow: hidden;
        }
        .rail.expanded {
          width: var(--rail-w-expanded);
          flex: 0 0 var(--rail-w-expanded);
        }
        .rail-items {
          display: flex;
          flex-direction: column;
          gap: 4px;
          width: 100%;
        }
        .rail-btn {
          position: relative;
          display: flex;
          align-items: center;
          height: 40px;
          width: 100%;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 2px;
          color: var(--ink-dim);
          padding: 0;
          white-space: nowrap;
        }
        .rail-ico {
          width: 56px;
          flex: 0 0 56px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .rail-ico svg {
          width: 19px;
          height: 19px;
        }
        .rail-lbl {
          display: none;
          font-size: 12px;
          font-weight: 500;
          letter-spacing: 0.01em;
        }
        .rail.expanded .rail-lbl {
          display: block;
        }
        .rail-btn:hover {
          color: var(--ink);
        }
        .rail-btn.active {
          color: var(--select-ink);
          background: var(--select-bg);
          border-color: var(--select-bg);
        }
        .rail-btn[data-tooltip]::after {
          content: attr(data-tooltip);
          position: absolute;
          left: calc(100% + 10px);
          top: 50%;
          transform: translateY(-50%);
          background: var(--ground-card);
          border: 1px solid var(--panel-border);
          box-shadow: var(--shadow-card);
          color: var(--ink);
          font-size: 11px;
          letter-spacing: 0.04em;
          white-space: nowrap;
          padding: 5px 9px;
          border-radius: 2px;
          opacity: 0;
          pointer-events: none;
          z-index: 20;
        }
        .rail-btn[data-tooltip]:hover::after {
          opacity: 1;
        }
        .rail-spacer {
          flex: 1;
          min-height: 12px;
        }
        .rail-foot {
          display: flex;
          justify-content: center;
          width: 100%;
          padding: 0 10px;
        }
        .rail.expanded .rail-foot {
          justify-content: flex-start;
        }
        .rail-version-chip {
          position: relative;
          flex: none;
          font-size: 11px;
          color: var(--ink-dim);
          background: var(--ground-card);
          border: 1px solid var(--chrome-lo);
          box-shadow: var(--bevel-in);
          border-radius: 2px;
          padding: 5px 9px;
          cursor: pointer;
        }
        .rail-version-chip:hover {
          color: var(--ink);
        }
        .rail-version-chip[data-tooltip]::after {
          content: attr(data-tooltip);
          position: absolute;
          left: calc(100% + 10px);
          top: 50%;
          transform: translateY(-50%);
          background: var(--ground-card);
          border: 1px solid var(--panel-border);
          box-shadow: var(--shadow-card);
          color: var(--ink);
          font-size: 11px;
          letter-spacing: 0.04em;
          white-space: nowrap;
          padding: 5px 9px;
          border-radius: 2px;
          opacity: 0;
          pointer-events: none;
          z-index: 20;
        }
        .rail-version-chip[data-tooltip]:hover::after {
          opacity: 1;
        }
        .rail-version-dot {
          position: absolute;
          top: -4px;
          right: -4px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--marker-red);
          border: 1px solid rgba(23, 25, 27, 0.35);
        }
      `}</style>
    </nav>
  );
}
