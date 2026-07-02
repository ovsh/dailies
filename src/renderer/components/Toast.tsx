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
          background: var(--ground-card);
          border: 1px solid var(--hairline-strong);
          box-shadow: var(--shadow-card);
          border-radius: 8px;
          padding: 12px 16px;
          font-size: 13px;
          color: var(--ink);
          animation: fade-up var(--dur-med) var(--ease-out) both;
          z-index: 500;
        }
        .toast-action {
          background: transparent;
          border: none;
          color: var(--accent);
          font-size: 12px;
          letter-spacing: 0.04em;
          padding: 0;
          border-bottom: 1px solid transparent;
        }
        .toast-action:hover {
          border-bottom-color: var(--accent);
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
