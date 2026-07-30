interface UpdateBannerProps {
  version: string;
  onRestart: () => void;
  onDismiss: () => void;
}

/**
 * Ambient, non-blocking: appears only once a download has finished. Pushes
 * layout down, never overlays content. See the approved mock, section A.
 */
export function UpdateBanner({ version, onRestart, onDismiss }: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status">
      <span className="update-banner-flag label">Update</span>
      <span className="update-banner-msg">
        Dailies <span className="mono">{version}</span> is ready. Restart takes seconds; your work is untouched.
      </span>
      <button className="marker-btn" onClick={onRestart}>
        Restart now
      </button>
      <button className="update-banner-later" onClick={onDismiss}>
        Later
      </button>

      <style>{`
        .update-banner {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          flex: none;
          /* Clear the fixed 34px hidden-titlebar drag strip (global.css
             .titlebar-drag, z-index 40): without this the banner is the first
             in-flow child of .app-main and its Restart/Later controls land
             inside the drag region — unclickable and colliding with anything
             pinned to the top-right corner. */
          margin-top: 34px;
          padding: 8px 20px;
          background: var(--ground-card);
          border-bottom: 1px solid var(--panel-border);
          box-shadow: var(--bevel-out);
          animation: update-banner-in var(--dur-med) var(--ease-out) both;
        }
        @keyframes update-banner-in {
          from { transform: translateY(-100%); }
          to { transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .update-banner {
            animation: none;
          }
        }
        .update-banner-flag {
          flex: none;
          color: #fff;
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          padding: 4px 7px;
          border-radius: 2px;
        }
        .update-banner-msg {
          font-size: 13px;
          font-weight: 500;
          flex: 1;
          min-width: 200px;
        }
        .marker-btn {
          font-family: var(--font-body);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #fff;
          background: var(--marker-red);
          border: 1px solid var(--marker-red-dn);
          border-radius: 2px;
          padding: 9px 16px;
          cursor: pointer;
          box-shadow:
            inset 1px 1px 0 rgba(255, 255, 255, 0.25),
            inset -1px -1px 0 rgba(0, 0, 0, 0.2),
            1px 2px 0 rgba(23, 25, 27, 0.28);
        }
        .marker-btn:active {
          box-shadow: inset 1px 1px 0 rgba(0, 0, 0, 0.2);
        }
        .update-banner-later {
          flex: none;
          font-family: var(--font-body);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          background: none;
          border: none;
          color: var(--accent);
          cursor: pointer;
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        .update-banner-later:hover {
          color: var(--accent-dim);
        }
      `}</style>
    </div>
  );
}
