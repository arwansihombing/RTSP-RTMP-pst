export type StreamStatus = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error';

export interface StreamRecord {
  id: string;
  name: string;
  rtsp_url: string;
  rtmp_url: string;
  enabled: number;
  auto_start: number;
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

export interface StreamView {
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

export interface ProbeResult {
  ok: boolean;
  codec_name: string | null;
  width: number | null;
  height: number | null;
  fps: string | null;
  has_audio: boolean;
  message: string;
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
