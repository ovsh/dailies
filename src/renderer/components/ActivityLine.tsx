interface ActivityLineProps {
  agent: string;
  status: string;
  index: number;
}

export function ActivityLine({ agent, status, index }: ActivityLineProps) {
  return (
    <div className="activity-line mono" style={{ animationDelay: `${index * 40}ms` }}>
      <span className="activity-agent label">{agent}</span>
      <span className="activity-status">{status}</span>
      <style>{`
        .activity-line {
          display: flex;
          align-items: baseline;
          gap: 10px;
          font-size: 12px;
          color: var(--ink-dim);
          animation: fade-in var(--dur-med) var(--ease-out) both;
          padding: 2px 0;
        }
        .activity-agent {
          flex: 0 0 auto;
          color: var(--accent-dim);
        }
        .activity-status {
          color: var(--ink-dim);
        }
      `}</style>
    </div>
  );
}
