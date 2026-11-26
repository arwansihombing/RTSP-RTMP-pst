import { useEffect, useState, type FormEvent } from 'react';
import { X, Activity, CheckCircle2, AlertCircle } from 'lucide-react';
import type { ProbeResult, StreamItem } from '../types';
import { apiFetch } from '../utils/authFetch';
import { validateStreamForm } from '../utils/streamFormat';

interface StreamModalProps {
  open: boolean;
  editingStream: StreamItem | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onUnauthorized?: () => void;
}

export function StreamModal({
  open,
  editingStream,
  onClose,
  onSaved,
  onUnauthorized,
}: StreamModalProps) {
  const [name, setName] = useState('');
  const [rtspUrl, setRtspUrl] = useState('');
  const [rtmpUrl, setRtmpUrl] = useState('');
  const [skipProbe, setSkipProbe] = useState(false);
  const [startNow, setStartNow] = useState(false);
  const [autoStartOnBoot, setAutoStartOnBoot] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<{
    loading: boolean;
    result: ProbeResult | null;
    error: string | null;
  }>({ loading: false, result: null, error: null });
  const [submitPhase, setSubmitPhase] = useState<'idle' | 'probing' | 'saving'>('idle');

  useEffect(() => {
    if (!open) return;
    if (editingStream) {
      setName(editingStream.name);
      setRtspUrl('');
      setRtmpUrl('');
      setSkipProbe(true);
      setStartNow(false);
      setAutoStartOnBoot(editingStream.auto_start);
    } else {
      setName('');
      setRtspUrl('');
      setRtmpUrl('');
      setSkipProbe(false);
      setStartNow(false);
      setAutoStartOnBoot(true);
    }
    setErrors({});
    setSubmitError(null);
    setProbeState({ loading: false, result: null, error: null });
    setSubmitPhase('idle');
  }, [open, editingStream]);

  if (!open) return null;

  const isEditing = editingStream !== null;
  const submitting = submitPhase !== 'idle';

  async function handleTestProbe() {
    const trimmed = rtspUrl.trim();
    if (!/^rtsps?:\/\//i.test(trimmed)) {
      setErrors((prev) => ({
        ...prev,
        rtsp_url: 'RTSP URL must start with rtsp:// (or rtsps://).',
      }));
      return;
    }

    setProbeState({ loading: true, result: null, error: null });
    try {
      const res = await apiFetch('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rtsp_url: trimmed }),
      });
      if (res.status === 401) {
        onUnauthorized?.();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setProbeState({
          loading: false,
          result: data.probe ?? null,
          error: data.error || 'FFprobe check failed',
        });
      } else {
        setProbeState({
          loading: false,
          result: data.probe,
          error: null,
        });
      }
    } catch {
      setProbeState({
        loading: false,
        result: null,
        error: 'Network error while running FFprobe',
      });
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const validationErrors = validateStreamForm({
      name,
      rtsp_url: rtspUrl,
      rtmp_url: rtmpUrl,
      isEditing,
    });

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});

    try {
      let cachedProbe: ProbeResult | null = probeState.result?.ok ? probeState.result : null;

      if (!isEditing && !skipProbe && !cachedProbe) {
        setSubmitPhase('probing');
        const probeRes = await apiFetch('/api/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rtsp_url: rtspUrl.trim() }),
        });
        if (probeRes.status === 401) {
          onUnauthorized?.();
          return;
        }
        const probeData = await probeRes.json();
        if (!probeRes.ok) {
          setSubmitError(probeData.error || 'FFprobe RTSP check failed');
          setSubmitPhase('idle');
          return;
        }
        cachedProbe = probeData.probe ?? null;
      }

      setSubmitPhase('saving');
      const endpoint = isEditing ? `/api/streams/${editingStream.id}` : '/api/streams';
      const method = isEditing ? 'PATCH' : 'POST';

      const payload = isEditing
        ? {
            name: name.trim(),
            ...(rtspUrl.trim() ? { rtsp_url: rtspUrl.trim() } : {}),
            ...(rtmpUrl.trim() ? { rtmp_url: rtmpUrl.trim() } : {}),
            auto_start: autoStartOnBoot,
          }
        : {
            name: name.trim(),
            rtsp_url: rtspUrl.trim(),
            rtmp_url: rtmpUrl.trim(),
            skip_probe: skipProbe,
            start_now: startNow,
            auto_start: autoStartOnBoot,
            probe_cache: cachedProbe,
          };

      const res = await apiFetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 401) {
        onUnauthorized?.();
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || 'Failed to save stream');
        setSubmitPhase('idle');
        return;
      }

      onSaved(isEditing ? `Updated "${name.trim()}"` : `Added "${name.trim()}"`);
    } catch {
      setSubmitError('Network error while saving stream');
    } finally {
      setSubmitPhase('idle');
    }
  }

  const submitLabel =
    submitPhase === 'probing'
      ? 'Testing RTSP...'
      : submitPhase === 'saving'
        ? 'Saving...'
        : isEditing
          ? 'Save Changes'
          : 'Add Stream';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stream-modal-title"
    >
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 id="stream-modal-title" className="text-base font-semibold text-slate-900">
            {isEditing ? 'Edit Stream Configuration' : 'Add RTSP to RTMP Stream'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close stream dialog"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="p-6 space-y-4">
          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 p-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-md"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
              <span>{submitError}</span>
            </div>
          )}

          <div>
            <label htmlFor="stream-name" className="block text-sm font-medium text-slate-700 mb-1">
              Camera / Stream Name
            </label>
            <input
              id="stream-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lobby Entrance DVR Ch1"
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="stream-rtsp" className="block text-sm font-medium text-slate-700">
                RTSP Source URL (DVR H.264)
              </label>
              {!isEditing && (
                <button
                  type="button"
                  onClick={handleTestProbe}
                  disabled={probeState.loading || submitting}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 disabled:opacity-50"
                >
                  <Activity className="h-3.5 w-3.5" />
                  {probeState.loading ? 'Probing...' : 'Test FFprobe'}
                </button>
              )}
            </div>
            {isEditing && editingStream && (
              <p className="mb-1.5 text-xs font-mono text-slate-500 break-all">
                Current: {editingStream.rtsp_url_masked}
              </p>
            )}
            <input
              id="stream-rtsp"
              type="url"
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              placeholder={
                isEditing
                  ? 'Kosongkan jika RTSP URL / password tidak diubah'
                  : 'rtsp://admin:pass@192.168.1.100:554/Streaming/Channels/101'
              }
              className="w-full px-3 py-2 text-sm font-mono text-slate-900 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
            {errors.rtsp_url && <p className="mt-1 text-xs text-red-600">{errors.rtsp_url}</p>}

            {probeState.result && probeState.result.ok && (
              <div className="mt-2 flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2.5 py-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {probeState.result.message}
                  {probeState.result.width && probeState.result.height
                    ? ` · ${probeState.result.width}x${probeState.result.height}`
                    : ''}
                </span>
              </div>
            )}

            {probeState.error && (
              <div className="mt-2 flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{probeState.error}</span>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="stream-rtmp" className="block text-sm font-medium text-slate-700 mb-1">
              RTMP Target URL (YouTube Live Ingest + Stream Key)
            </label>
            {isEditing && editingStream && (
              <p className="mb-1.5 text-xs font-mono text-slate-500 break-all">
                Current: {editingStream.rtmp_url_masked}
                {editingStream.needs_stream_key ? ' (Perlu isi Stream Key!)' : ''}
              </p>
            )}
            <input
              id="stream-rtmp"
              type="url"
              value={rtmpUrl}
              onChange={(e) => setRtmpUrl(e.target.value)}
              placeholder={
                isEditing
                  ? 'Kosongkan jika tidak diubah (isi URL lengkap untuk ganti Stream Key)'
                  : 'rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx-xxxx'
              }
              className="w-full px-3 py-2 text-sm font-mono text-slate-900 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
            {errors.rtmp_url && <p className="mt-1 text-xs text-red-600">{errors.rtmp_url}</p>}
          </div>

          <div className="pt-1 space-y-2 border-t border-slate-100">
            {!isEditing && (
              <>
                <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipProbe}
                    onChange={(e) => setSkipProbe(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span>Skip FFprobe pre-check (save offline/LAN camera without probing)</span>
                </label>

                <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={startNow}
                    onChange={(e) => setStartNow(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span>Start FFmpeg passthrough immediately after saving</span>
                </label>
              </>
            )}

            <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={autoStartOnBoot}
                onChange={(e) => setAutoStartOnBoot(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <span>Auto-start automatically when server restarts (auto_start=1)</span>
            </label>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
