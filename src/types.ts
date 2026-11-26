export type StreamStatus = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error';

export interface StreamItem {
  id: string;
  name: string;
  rtsp_url_masked: string;
  rtmp_url_masked: string;
  needs_stream_key: boolean;
  enabled: boolean;
  auto_start: boolean;
  status: StreamStatus;
  pid: number | null;
  uptime_seconds: number;
  retry_count: number;
  last_error: string | null;
  bitrate_kbps: number;
  bytes_sent: number;
  fps: number | null;
  last_probe_width: number | null;
  last_probe_height: number | null;
  last_probe_fps: string | null;
  created_at: string;
  updated_at: string;
}

export interface StreamLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'critical';
  message: string;
}

export interface ProbeResult {
  ok: boolean;
  codec_name: string | null;
  width: number | null;
  height: number | null;
  fps: string | null;
  has_audio: boolean;
  message: string;
}

export interface RustFileItem {
  path: string;
  content: string;
}

export interface BandwidthSample {
  timestamp: number;
  stream_egress_kbps: number;
  host_rx_kbps: number;
  host_tx_kbps: number;
}

export interface BandwidthSnapshot {
  stream_egress_kbps: number;
  host_rx_kbps: number;
  host_tx_kbps: number;
  total_bytes_sent: number;
  host_rx_bytes_session: number;
  host_tx_bytes_session: number;
  active_streams: number;
  interface_count: number;
  history: BandwidthSample[];
}

export interface FfmpegOsSession {
  pid: number;
  ppid: number;
  elapsed_seconds: number;
  managed: boolean;
  stream_id: string | null;
  stream_name: string | null;
  streambridge_signature: boolean;
  command: string;
}

export interface FfmpegSessionsSnapshot {
  sessions: FfmpegOsSession[];
  total_os_ffmpeg: number;
  orphan_count: number;
}
