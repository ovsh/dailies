interface TimecodeTextProps {
  tc: string;
  dim?: boolean;
  className?: string;
}

/** Tabular-mono span for timecodes and other machine-precise metadata. */
export function TimecodeText({ tc, dim, className }: TimecodeTextProps) {
  return (
    <span
      className={`mono${className ? ` ${className}` : ""}`}
      style={{ color: dim ? "var(--ink-dimmer)" : "var(--ink)" }}
    >
      {tc}
    </span>
  );
}
