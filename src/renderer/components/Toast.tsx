interface ToastProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}

export function Toast({ message, actionLabel, onAction, onDismiss }: ToastProps) {
  return (
    <div className="toast">
      <span className="toast-msg">{message}</span>
      {actionLabel && onAction && (
        <button className="toast-action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
      <style>{`
        .toast-msg {
          font-size: 12.5px;
          color: var(--ink-dim);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 420px;
        }
        .toast {
          position: fixed;
          left: 50%;
          bottom: 32px;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: 16px;
          background: var(--ground-raised);
          border: 1px solid var(--panel-border);
          box-shadow: var(--bevel-out), var(--shadow-card);
          border-radius: 2px;
          padding: 12px 16px;
          font-size: 13px;
          color: var(--ink);
          animation: fade-up var(--dur-med) var(--ease-out) both;
          z-index: 500;
        }
        .toast-action {
          background: var(--ground-raised);
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          color: var(--ink);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 4px 10px;
        }
        .toast-action:hover {
          background: #d2d6d9;
        }
        .toast-action:active {
          box-shadow: var(--bevel-in);
        }
        .toast-close {
          background: transparent;
          border: none;
          color: var(--ink-dimmer);
          font-size: 16px;
          line-height: 1;
          padding: 0 0 0 4px;
        }
        .toast-close:hover {
          color: var(--ink-dim);
        }
      `}</style>
    </div>
  );
}
