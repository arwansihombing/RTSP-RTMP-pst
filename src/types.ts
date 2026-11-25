export type StreamStatus = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error';

export interface StreamItem {
  id: string;
  name: string;
  rtsp_url: string;
  rtmp_url: string;
  enabled: boolean;
  status: StreamStatus;
  pid: number | null;
  uptime_seconds: number;
  retry_count: number;
  last_error: string | null;
  bitrate_kbps: number;
  bytes_sent: number;
  fps: number | null;
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
