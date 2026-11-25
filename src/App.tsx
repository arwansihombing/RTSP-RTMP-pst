import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Play,
  Square,
  Pencil,
  Terminal,
  Trash2,
  Activity,
  Search,
  X,
  CheckCircle2,
  AlertCircle,
  LogOut,
} from 'lucide-react';
import { BandwidthPanel } from './components/BandwidthPanel';
import { DeleteModal } from './components/DeleteModal';
import { LoginView } from './components/LoginView';
import { LogsModal } from './components/LogsModal';
import { RustProjectView } from './components/RustProjectView';
import { SpecView } from './components/SpecView';
import { StatusBadge } from './components/StatusBadge';
import { StreamModal } from './components/StreamModal';
import type { BandwidthSnapshot, StreamItem, StreamStatus } from './types';
import {
  formatBitrate,
  formatBytes,
  formatUptime,
  maskRtmpUrl,
  truncateMiddle,
} from './utils/streamFormat';

type ActiveTab = 'streams' | 'spec' | 'rust';
type StatusFilter = 'all' | StreamStatus;

interface ToastMessage {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  const [activeTab, setActiveTab] = useState<ActiveTab>('streams');
  const [streams, setStreams] = useState<StreamItem[]>([]);
  const [bandwidth, setBandwidth] = useState<BandwidthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [streamModalOpen, setStreamModalOpen] = useState(false);
  const [editingStream, setEditingStream] = useState<StreamItem | null>(null);
  const [logsStream, setLogsStream] = useState<StreamItem | null>(null);
  const [deletingStream, setDeletingStream] = useState<StreamItem | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((kind: 'success' | 'error', text: string) => {
    const id = Date.now();
    setToast({ id, kind, text });
    setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 4500);
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/auth/session')
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        setAuthenticated(Boolean(data?.authenticated));
      })
      .catch(() => {
        if (!active) return;
        setAuthenticated(false);
      })
      .finally(() => {
        if (active) setAuthChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const fetchStreams = useCallback(async (isInitial = false) => {
    try {
      const res = await fetch('/api/streams');
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setStreams(Array.isArray(data.streams) ? data.streams : []);
      setLoadError(null);
    } catch {
      if (isInitial) {
        setLoadError('Unable to reach StreamBridge API.');
      }
    } finally {
      if (isInitial) {
        setLoading(false);
      }
    }
  }, []);

  const fetchBandwidth = useCallback(async () => {
    try {
      const res = await fetch('/api/bandwidth');
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as BandwidthSnapshot;
        setBandwidth(data);
      }
    } catch {
      // ignore transient poll error
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    setLoading(true);
    void fetchStreams(true);
    void fetchBandwidth();

    const streamsIntervalId = setInterval(() => {
      if (!document.hidden) {
        void fetchStreams(false);
      }
    }, 2000);

    const bwIntervalId = setInterval(() => {
      if (!document.hidden) {
        void fetchBandwidth();
      }
    }, 1000);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void fetchStreams(false);
        void fetchBandwidth();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(streamsIntervalId);
      clearInterval(bwIntervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [authenticated, fetchStreams, fetchBandwidth]);

  const counts = useMemo(() => {
    let running = 0;
    let reconnecting = 0;
    let error = 0;
    for (const s of streams) {
      if (s.status === 'running') running += 1;
      else if (s.status === 'reconnecting' || s.status === 'starting') reconnecting += 1;
      else if (s.status === 'error') error += 1;
    }
    return {
      total: streams.length,
      running,
      reconnecting,
      error,
    };
  }, [streams]);

  const filteredStreams = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return streams.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.rtsp_url.toLowerCase().includes(q) ||
        s.rtmp_url.toLowerCase().includes(q)
      );
    });
  }, [streams, searchQuery, statusFilter]);

  function setRowBusy(id: string, busy: boolean) {
    setBusyIds((prev) => ({ ...prev, [id]: busy }));
  }

  async function handleStart(stream: StreamItem) {
    setRowBusy(stream.id, true);
    try {
      const res = await fetch(`/api/streams/${stream.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({}),
      });
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        showToast('error', data.error || `Failed to start "${stream.name}"`);
      } else {
        showToast('success', `Started "${stream.name}"`);
      }
      await fetchStreams(false);
    } catch {
      showToast('error', `Network error starting "${stream.name}"`);
    } finally {
      setRowBusy(stream.id, false);
    }
  }

  async function handleStop(stream: StreamItem) {
    setRowBusy(stream.id, true);
    try {
      const res = await fetch(`/api/streams/${stream.id}/stop`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        showToast('error', data.error || `Failed to stop "${stream.name}"`);
      } else {
        showToast('success', `Stopped "${stream.name}"`);
      }
      await fetchStreams(false);
    } catch {
      showToast('error', `Network error stopping "${stream.name}"`);
    } finally {
      setRowBusy(stream.id, false);
    }
  }

  async function handleProbe(stream: StreamItem) {
    setRowBusy(stream.id, true);
    try {
      const res = await fetch(`/api/streams/${stream.id}/probe`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        showToast('error', data.error || `Probe failed for "${stream.name}"`);
      } else {
        showToast('success', data.probe?.message || `H.264 verified for "${stream.name}"`);
      }
    } catch {
      showToast('error', `Network error probing "${stream.name}"`);
    } finally {
      setRowBusy(stream.id, false);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingStream) return;
    setDeletingBusy(true);
    try {
      const res = await fetch(`/api/streams/${deletingStream.id}`, {
        method: 'DELETE',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast('error', data.error || `Failed to delete "${deletingStream.name}"`);
      } else {
        showToast('success', `Deleted "${deletingStream.name}"`);
        setDeletingStream(null);
        await fetchStreams(false);
      }
    } catch {
      showToast('error', 'Network error deleting stream');
    } finally {
      setDeletingBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
    } finally {
      setStreams([]);
      setAuthenticated(false);
    }
  }

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Loading StreamBridge...
      </div>
    );
  }

  if (!authenticated) {
    return <LoginView onLoginSuccess={() => setAuthenticated(true)} />;
  }

  const filterTabs: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'running', label: 'Running' },
    { id: 'reconnecting', label: 'Reconnecting' },
    { id: 'error', label: 'Error' },
    { id: 'stopped', label: 'Stopped' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar Contract: Brand wordmark — Nav links — 1 primary CTA */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4 sm:gap-8">
          <a
            href="#streams"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('streams');
            }}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            StreamBridge
          </a>

          <nav aria-label="Primary navigation" className="hidden sm:flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              onClick={() => setActiveTab('streams')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'streams'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Streams
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('spec')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'spec'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              FFmpeg Spec
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('rust')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'rust'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Rust Project
            </button>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setEditingStream(null);
                setStreamModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              Add Stream
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              aria-label="Logout"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>

        {/* Mobile sub-navigation bar to avoid header overflow on 390px viewports */}
        <nav
          aria-label="Mobile navigation"
          className="sm:hidden flex items-center gap-6 px-4 py-2 border-t border-slate-100 text-xs font-medium overflow-x-auto"
        >
          <button
            type="button"
            onClick={() => setActiveTab('streams')}
            className={`py-1 border-b-2 whitespace-nowrap shrink-0 ${
              activeTab === 'streams' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500'
            }`}
          >
            Streams
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('spec')}
            className={`py-1 border-b-2 whitespace-nowrap shrink-0 ${
              activeTab === 'spec' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500'
            }`}
          >
            FFmpeg Spec
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('rust')}
            className={`py-1 border-b-2 whitespace-nowrap shrink-0 ${
              activeTab === 'rust' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500'
            }`}
          >
            Rust Project
          </button>
        </nav>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8 space-y-6">
        {toast && (
          <div
            role="status"
            aria-live="polite"
            className={`flex items-center justify-between gap-3 px-4 py-3 text-sm rounded-md border ${
              toast.kind === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-900'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {toast.kind === 'success' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
              )}
              <span>{toast.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss notification"
              className="p-1 rounded hover:bg-black/5"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {activeTab === 'streams' && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 text-balance">
                  RTSP to YouTube RTMP Passthrough
                </h1>
                <p className="text-sm text-slate-600 mt-1">
                  Zero-transcoding H.264 stream copy (<code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">-c:v copy -an -map 0:v:0</code>) with per-camera FFmpeg supervision.
                </p>
              </div>
            </div>

            {/* Unified 4-column summary bar */}
            <section
              aria-label="Stream summary metrics"
              className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 lg:grid-cols-4 overflow-hidden [&>*]:border-slate-200 [&>*:nth-child(odd)]:border-r [&>*:nth-child(-n+2)]:border-b lg:[&>*]:border-b-0 lg:[&>*:not(:last-child)]:border-r"
            >
              <div className="p-4 sm:px-6">
                <div className="text-xs font-medium text-slate-500">Total Streams</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
                  {counts.total}
                </div>
              </div>
              <div className="p-4 sm:px-6">
                <div className="text-xs font-medium text-slate-500">Running</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-700 tabular-nums">
                  {counts.running}
                </div>
              </div>
              <div className="p-4 sm:px-6">
                <div className="text-xs font-medium text-slate-500">Reconnecting</div>
                <div className="mt-1 text-2xl font-semibold text-amber-700 tabular-nums">
                  {counts.reconnecting}
                </div>
              </div>
              <div className="p-4 sm:px-6">
                <div className="text-xs font-medium text-slate-500">Errors</div>
                <div className="mt-1 text-2xl font-semibold text-red-700 tabular-nums">
                  {counts.error}
                </div>
              </div>
            </section>

            <BandwidthPanel bandwidth={bandwidth} />

            {/* Filter & Search Toolbar */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-sm">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by camera name or URL..."
                  aria-label="Filter streams"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg overflow-x-auto max-w-full" role="group" aria-label="Filter by stream status">
                {filterTabs.map((tab) => {
                  const active = statusFilter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setStatusFilter(tab.id)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        active
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Streams Table */}
            <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              {loadError ? (
                <div className="p-10 text-center space-y-3">
                  <p className="text-sm text-red-700 font-medium">{loadError}</p>
                  <button
                    type="button"
                    onClick={() => void fetchStreams(true)}
                    className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
                  >
                    Retry
                  </button>
                </div>
              ) : loading ? (
                <div className="divide-y divide-slate-200">
                  {[1, 2, 3].map((row) => (
                    <div key={row} className="px-6 py-4 flex items-center justify-between gap-4 animate-pulse">
                      <div className="h-4 w-44 bg-slate-200 rounded" />
                      <div className="h-4 w-56 bg-slate-100 rounded hidden md:block" />
                      <div className="h-4 w-20 bg-slate-200 rounded" />
                      <div className="h-8 w-36 bg-slate-100 rounded" />
                    </div>
                  ))}
                </div>
              ) : filteredStreams.length === 0 ? (
                <div className="p-12 text-center space-y-3">
                  <h2 className="text-base font-semibold text-slate-900">
                    {streams.length === 0 ? 'No streams configured yet' : 'No streams match your filter'}
                  </h2>
                  <p className="text-sm text-slate-500 max-w-md mx-auto">
                    {streams.length === 0
                      ? 'Add an H.264 RTSP camera source and a YouTube Live RTMP ingest URL to start zero-transcoding passthrough.'
                      : 'Clear the search query or switch the status filter to see all configured cameras.'}
                  </p>
                  {streams.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingStream(null);
                        setStreamModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
                    >
                      <Plus className="h-4 w-4" />
                      Add First Stream
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setStatusFilter('all');
                      }}
                      className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      Reset Filters
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                        <th className="py-3 px-4">Name</th>
                        <th className="py-3 px-3">RTSP Source</th>
                        <th className="py-3 px-3">RTMP Target</th>
                        <th className="py-3 px-3">Status</th>
                        <th className="py-3 px-3 text-right">Bandwidth</th>
                        <th className="py-3 px-3 text-right">Uptime</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {filteredStreams.map((stream) => {
                        const isActive =
                          stream.status === 'running' ||
                          stream.status === 'starting' ||
                          stream.status === 'reconnecting';
                        const rowBusy = Boolean(busyIds[stream.id]);

                        return (
                          <tr key={stream.id} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3.5 px-4">
                              <div className="font-medium text-slate-900 whitespace-nowrap truncate max-w-[170px]" title={stream.name}>
                                {stream.name}
                              </div>
                              {stream.last_error && (
                                <div
                                  className="text-xs text-red-600 mt-0.5 max-w-[170px] truncate"
                                  title={stream.last_error}
                                >
                                  {stream.last_error}
                                </div>
                              )}
                            </td>

                            <td className="py-3.5 px-3">
                              <span
                                className="font-mono text-xs text-slate-700 block max-w-[145px] truncate"
                                title={stream.rtsp_url}
                              >
                                {truncateMiddle(stream.rtsp_url, 24)}
                              </span>
                            </td>

                            <td className="py-3.5 px-3">
                              <span
                                className="font-mono text-xs text-slate-700 block max-w-[145px] truncate"
                                title={stream.rtmp_url}
                              >
                                {maskRtmpUrl(stream.rtmp_url)}
                              </span>
                            </td>

                            <td className="py-3.5 px-3">
                              <StatusBadge status={stream.status} retryCount={stream.retry_count} />
                            </td>

                            <td className="py-3.5 px-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                              <div className={stream.bitrate_kbps > 0 ? 'text-emerald-700 font-medium' : 'text-slate-600'}>
                                {formatBitrate(stream.bitrate_kbps)}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {formatBytes(stream.bytes_sent)}
                              </div>
                            </td>

                            <td className="py-3.5 px-3 text-right font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                              {formatUptime(stream.uptime_seconds)}
                            </td>

                            <td className="py-3.5 px-4">
                              <div className="flex items-center justify-end gap-1.5">
                                {isActive ? (
                                  <button
                                    type="button"
                                    disabled={rowBusy}
                                    onClick={() => void handleStop(stream)}
                                    aria-label={`Stop ${stream.name}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 disabled:opacity-50 whitespace-nowrap"
                                  >
                                    <Square className="h-3 w-3" />
                                    Stop
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={rowBusy}
                                    onClick={() => void handleStart(stream)}
                                    aria-label={`Start ${stream.name}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap"
                                  >
                                    <Play className="h-3 w-3" />
                                    Start
                                  </button>
                                )}

                                <button
                                  type="button"
                                  disabled={rowBusy}
                                  onClick={() => void handleProbe(stream)}
                                  aria-label={`Probe ${stream.name}`}
                                  title="Run FFprobe H.264 check"
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                                >
                                  <Activity className="h-3.5 w-3.5" />
                                  Probe
                                </button>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingStream(stream);
                                    setStreamModalOpen(true);
                                  }}
                                  aria-label={`Edit ${stream.name}`}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit
                                </button>

                                <button
                                  type="button"
                                  onClick={() => setLogsStream(stream)}
                                  aria-label={`View logs for ${stream.name}`}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
                                >
                                  <Terminal className="h-3.5 w-3.5" />
                                  Logs
                                </button>

                                <button
                                  type="button"
                                  onClick={() => setDeletingStream(stream)}
                                  aria-label={`Delete ${stream.name}`}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-white border border-slate-300 rounded-md hover:bg-red-50 hover:border-red-200 whitespace-nowrap"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {activeTab === 'spec' && <SpecView />}
        {activeTab === 'rust' && <RustProjectView />}
      </main>

      <StreamModal
        open={streamModalOpen}
        editingStream={editingStream}
        onClose={() => {
          setStreamModalOpen(false);
          setEditingStream(null);
        }}
        onSaved={(message) => {
          setStreamModalOpen(false);
          setEditingStream(null);
          showToast('success', message);
          void fetchStreams(false);
        }}
      />

      <LogsModal
        stream={logsStream}
        onClose={() => setLogsStream(null)}
      />

      <DeleteModal
        stream={deletingStream}
        deleting={deletingBusy}
        onCancel={() => setDeletingStream(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}
