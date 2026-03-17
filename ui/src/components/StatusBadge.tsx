interface StatusBadgeProps {
  status: 'ok' | 'warning' | 'error' | 'running' | 'stopped' | 'unknown';
  label?: string;
}

const STYLES: Record<string, string> = {
  ok: 'bg-gstack-accent-bg text-gstack-accent border-gstack-accent/30',
  warning: 'bg-gstack-warning-bg text-gstack-warning border-gstack-warning/30',
  error: 'bg-gstack-danger-bg text-gstack-danger border-gstack-danger/30',
  running: 'bg-gstack-accent-bg text-gstack-accent border-gstack-accent/30',
  stopped: 'bg-gstack-border text-gstack-dim border-gstack-border',
  unknown: 'bg-gstack-border text-gstack-dim border-gstack-border',
};

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${STYLES[status] ?? STYLES['unknown']}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          status === 'ok' || status === 'running'
            ? 'bg-gstack-accent'
            : status === 'warning'
              ? 'bg-gstack-warning'
              : status === 'error'
                ? 'bg-gstack-danger'
                : 'bg-gstack-dim'
        }`}
      />
      {label ?? status}
    </span>
  );
}
