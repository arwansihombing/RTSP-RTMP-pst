import { useEffect, useState } from 'react';
import { X, RefreshCw, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { FfmpegSessionsSnapshot } from '../types';
import { apiFetch } from '../utils/authFetch';
import { formatUptime } from '../utils/streamFormat';

interface SessionsModalProps {
  open: boolean;
  onClose: () => void;
  onUnauthorized?: () => void;
  onCleaned?: (message: string) => void;
}

export function SessionsModal({ open, onClose, onUnauthorized, onCleaned }: SessionsModalProps) {
  const [snapshot, setSnapshot] = useState<FfmpegSessionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  async function loadSessions() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/sessions');
      if (res.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as FfmpegSessionsSnapshot;
        setSnapshot(data);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadSessions();
  }, [open]);

  if (!open) return null;

  async function handleCleanup() {
    setCleaning(true);
    try {
      const res = await apiFetch('/api/sessions/cleanup', { method: 'POST' });
      if (res.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setSnapshot({
          sessions: data.sessions ?? [],
          total_os_ffmpeg: data.total_os_ffmpeg ?? 0,
          orphan_count: data.orphan_count ?? 0,
        });
        const killedCount = Array.isArray(data.killed_pids) ? data.killed_pids.length : 0;
        onCleaned?.(
          killedCount > 0
            ? `Terminated ${killedCount} orphan FFmpeg process(es).`
            : 'No orphan FFmpeg processes found.',
        );
      }
    } finally {
      setCleaning(false);
    }
  }

  const sessions = snapshot?.sessions ?? [];
  const orphanCount = snapshot?.orphan_count ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sessions-modal-title"
    >
      <div className="w-full max-w-3xl bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200">
          <div>
            <h2 id="sessions-modal-title" className="text-base font-semibold text-slate-900">
              Active OS FFmpeg Sessions
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              {snapshot
                ? `${snapshot.total_os_ffmpeg} FFmpeg process(es) detected · ${orphanCount} orphan`
                : 'Inspecting running FFmpeg processes...'}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadSessions()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>

            {orphanCount > 0 && (
              <button
                type="button"
                onClick={() => void handleCleanup()}
                disabled={cleaning}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {cleaning ? 'Stopping...' : `Kill Orphan (${orphanCount})`}
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close sessions dialog"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          {orphanCount > 0 && (
            <div className="flex items-start gap-2.5 p-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                Detected {orphanCount} untracked FFmpeg process(es) still running in the OS. Use Kill Orphan to prevent duplicate encoders pushing to the same YouTube stream key.
              </span>
            </div>
          )}

          {loading && !snapshot ? (
            <div className="py-8 text-center text-sm text-slate-500">Checking OS FFmpeg processes...</div>
          ) : sessions.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">
              No FFmpeg processes are currently running on the host.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-md overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                    <th className="py-2.5 px-3">PID</th>
                    <th className="py-2.5 px-3">Session</th>
                    <th className="py-2.5 px-3">Stream</th>
                    <th className="py-2.5 px-3 text-right">Uptime</th>
                    <th className="py-2.5 px-3">Command (Masked)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {sessions.map((proc) => (
                    <tr key={proc.pid}>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-900">{proc.pid}</td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {proc.managed ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Managed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Orphan
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {proc.stream_name ?? 'Untracked'}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-600 whitespace-nowrap">
                        {formatUptime(proc.elapsed_seconds)}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-600 max-w-xs truncate" title={proc.command}>
                        {proc.command}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
