import type { ReactElement } from "react";
import type { Screen } from "../App";

interface RailProps {
  screen: Screen;
  onNavigate: (screen: Screen) => void;
  /** Full project name, e.g. "DUCK DYNASTY" — rendered as initials with a tooltip. */
  projectName: string;
  onOpenProjects: () => void;
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

function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function Rail({ screen, onNavigate, projectName, onOpenProjects }: RailProps) {
  return (
    <nav className="rail">
      <div className="rail-mark display" aria-label="Dailies">
        D.
      </div>
      <button
        className="rail-project"
        onClick={onOpenProjects}
        aria-label={projectName}
        data-tooltip={projectName}
      >
        <span className="rail-project-initials display">{projectInitials(projectName)}</span>
      </button>
      <div className="rail-items">
        {ITEMS.map((item) => (
          <button
            key={item.screen}
            className={`rail-btn${screen === item.screen ? " active" : ""}`}
            onClick={() => onNavigate(item.screen)}
            aria-label={item.label}
            data-tooltip={item.label}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              {item.icon}
            </svg>
          </button>
        ))}
      </div>
      <style>{`
        .rail {
          width: var(--rail-w);
          flex: 0 0 var(--rail-w);
          height: 100%;
          background: var(--ground-raised);
          border-right: 1px solid var(--hairline);
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 20px 0 24px;
        }
        .rail-mark {
          font-size: 22px;
          color: var(--accent);
          margin-bottom: 20px;
          user-select: none;
        }
        .rail-project {
          position: relative;
          width: 30px;
          height: 30px;
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: 1px solid var(--hairline-strong);
          border-radius: 50%;
          color: var(--ink-dim);
          margin-bottom: 36px;
          transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
        }
        .rail-project:hover {
          border-color: var(--accent-dim);
          color: var(--accent);
        }
        .rail-project-initials {
          font-size: 12px;
          letter-spacing: 0.02em;
          user-select: none;
        }
        .rail-items {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .rail-btn {
          position: relative;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: var(--ink-dimmer);
          transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
        }
        .rail-btn svg {
          width: 19px;
          height: 19px;
        }
        .rail-btn:hover {
          color: var(--ink-dim);
          background: rgba(255, 255, 255, 0.03);
        }
        .rail-btn.active {
          color: var(--accent);
        }
        .rail-btn.active::before {
          content: "";
          position: absolute;
          left: -12px;
          top: 50%;
          transform: translateY(-50%);
          width: 2px;
          height: 16px;
          background: var(--accent);
          border-radius: 1px;
        }
        .rail-btn[data-tooltip]::after,
        .rail-project[data-tooltip]::after {
          content: attr(data-tooltip);
          position: absolute;
          left: calc(100% + 10px);
          top: 50%;
          transform: translateY(-50%) translateX(-4px);
          background: var(--ground-card);
          border: 1px solid var(--hairline-strong);
          color: var(--ink-dim);
          font-size: 11px;
          letter-spacing: 0.04em;
          white-space: nowrap;
          padding: 5px 9px;
          border-radius: 5px;
          opacity: 0;
          pointer-events: none;
          transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
          z-index: 20;
        }
        .rail-btn[data-tooltip]:hover::after,
        .rail-project[data-tooltip]:hover::after {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }
      `}</style>
    </nav>
  );
}
