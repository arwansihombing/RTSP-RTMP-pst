import type { StreamStatus } from '../types';

interface StatusBadgeProps {
  status: StreamStatus;
  retryCount?: number;
}

const STATUS_META: Record<
  StreamStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  running: {
    label: 'Running',
    dotClass: 'bg-emerald-600',
    textClass: 'text-emerald-700',
  },
  reconnecting: {
    label: 'Reconnecting',
    dotClass: 'bg-amber-600',
    textClass: 'text-amber-700',
  },
  starting: {
    label: 'Starting',
    dotClass: 'bg-sky-600',
    textClass: 'text-sky-700',
  },
  error: {
    label: 'Error',
    dotClass: 'bg-red-600',
    textClass: 'text-red-700',
  },
  stopped: {
    label: 'Stopped',
    dotClass: 'bg-slate-400',
    textClass: 'text-slate-600',
  },
};

export function StatusBadge({ status, retryCount = 0 }: StatusBadgeProps) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-medium whitespace-nowrap ${meta.textClass}`}>
      <span className={`h-2 w-2 rounded-full shrink-0 ${meta.dotClass}`} aria-hidden="true" />
      <span>
        {meta.label}
        {status === 'reconnecting' && retryCount > 0 ? ` (${retryCount}/10)` : ''}
      </span>
    </span>
  );
}
