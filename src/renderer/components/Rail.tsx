import type { ReactElement } from "react";
import type { Screen } from "../App";

interface RailProps {
  screen: Screen;
  onNavigate: (screen: Screen) => void;
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
    label: "Jobs & Settings",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l2.6 2.6" />
      </>
    ),
  },
];

export function Rail({ screen, onNavigate }: RailProps) {
  return (
    <nav className="rail">
      <div className="rail-mark display" aria-label="Dailies">
        D.
      </div>
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
          margin-bottom: 36px;
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
        .rail-btn[data-tooltip]::after {
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
        .rail-btn[data-tooltip]:hover::after {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }
      `}</style>
    </nav>
  );
}
