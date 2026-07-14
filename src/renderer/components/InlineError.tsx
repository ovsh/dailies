interface InlineErrorProps {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}

export function InlineError({ message, onRetry, retrying = false }: InlineErrorProps) {
  return (
    <div className="inline-error mono" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} disabled={retrying}>
          {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
      <style>{`
        .inline-error {
          display: flex;
          align-items: baseline;
          gap: 10px;
          color: var(--status-error);
          font-size: 11px;
          line-height: 1.5;
          margin: 12px 0;
        }
        .inline-error button {
          flex: 0 0 auto;
          border: none;
          border-bottom: 1px solid currentColor;
          background: transparent;
          color: var(--ink-dim);
          font: inherit;
          padding: 0;
        }
        .inline-error button:hover:not(:disabled) {
          color: var(--accent);
        }
        .inline-error button:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
      `}</style>
    </div>
  );
}
