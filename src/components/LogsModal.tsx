import { useEffect, useRef, useState } from 'react';
import { X, Copy, RefreshCw, Check } from 'lucide-react';
import type { StreamItem, StreamLogEntry } from '../types';
import { apiFetch } from '../utils/authFetch';

interface LogsModalProps {
  stream: StreamItem | null;
  onClose: () => void;
  onUnauthorized?: () => void;
}

const LEVEL_STYLES: Record<StreamLogEntry['level'], string> = {
  info: 'text-slate-300',
  warn: 'text-amber-300',
  error: 'text-red-400',
  critical: 'text-red-300 font-semibold',
};

export function LogsModal({ stream, onClose, onUnauthorized }: LogsModalProps) {
  const [logs, setLogs] = useState<StreamLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);

  async function fetchLogs(streamId: string, showSpinner = false) {
    if (showSpinner) setLoading(true);
    try {
      const res = await apiFetch(`/api/streams/${streamId}/logs`);
      if (res.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setLogs(Array.isArray(data.logs) ? data.logs : []);
      }
    } finally {
      if (showSpinner) setLoading(false);
    }
  }

  useEffect(() => {
    if (!stream) return;
    void fetchLogs(stream.id, true);

    const timer = setInterval(() => {
      if (!document.hidden) {
        void fetchLogs(stream.id, false);
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [stream]);

  useEffect(() => {
    if (autoScroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  if (!stream) return null;

  async function handleCopy() {
    const text = logs
      .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard fallback ignored in restricted frames
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="logs-modal-title"
    >
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200">
          <div className="min-w-0">
            <h2 id="logs-modal-title" className="text-base font-semibold text-slate-900 truncate">
              Process Logs — {stream.name}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              Ring buffer (last 200 lines) · Status: {stream.status}
              {stream.pid ? ` · PID ${stream.pid}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 mr-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <span>Auto-scroll</span>
            </label>

            <button
              type="button"
              onClick={() => void fetchLogs(stream.id, true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>

            <button
              type="button"
              onClick={handleCopy}
              disabled={logs.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close logs modal"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <pre
          ref={preRef}
          className="flex-1 min-h-[320px] max-h-[60vh] overflow-y-auto bg-slate-950 text-slate-200 p-4 text-xs leading-relaxed font-mono whitespace-pre-wrap break-all"
        >
          {loading && logs.length === 0
            ? 'Loading FFmpeg stderr buffer...'
            : logs.length === 0
              ? 'No log output yet. Start or probe this stream to inspect FFmpeg/FFprobe output.'
              : logs.map((entry, idx) => (
                  <div key={`${entry.timestamp}-${idx}`} className={LEVEL_STYLES[entry.level]}>
                    <span className="text-slate-500 select-none mr-2">
                      {entry.timestamp.slice(11, 19)}
                    </span>
                    <span className="uppercase text-[11px] mr-2 opacity-80">[{entry.level}]</span>
                    <span>{entry.message}</span>
                  </div>
                ))}
        </pre>
      </div>
    </div>
  );
}
