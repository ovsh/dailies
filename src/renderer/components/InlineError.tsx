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
          background: #f6e9e7;
          border: 1px solid var(--status-error);
          border-radius: 2px;
          padding: 8px 10px;
          font-size: 11px;
          line-height: 1.5;
          margin: 12px 0;
        }
        .inline-error button {
          flex: 0 0 auto;
          border: 1px solid var(--chrome-lo);
          border-radius: 2px;
          box-shadow: var(--bevel-out);
          background: var(--ground-raised);
          color: var(--ink);
          font: inherit;
          padding: 3px 9px;
        }
        .inline-error button:hover:not(:disabled) {
          background: #d2d6d9;
        }
        .inline-error button:active:not(:disabled) {
          box-shadow: var(--bevel-in);
        }
        .inline-error button:disabled {
          color: var(--ink-faint);
          cursor: default;
        }
      `}</style>
    </div>
  );
}
