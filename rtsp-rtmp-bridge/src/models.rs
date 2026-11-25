use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamStatus {
    Stopped,
    Starting,
    Running,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct StreamRecord {
    pub id: String,
    pub name: String,
    pub rtsp_url: String,
    pub rtmp_url: String,
    pub enabled: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamView {
    pub id: Uuid,
    pub name: String,
    pub rtsp_url: String,
    pub rtmp_url: String,
    pub enabled: bool,
    pub status: StreamStatus,
    pub pid: Option<u32>,
    pub uptime_seconds: u64,
    pub retry_count: u32,
    pub last_error: Option<String>,
    pub bitrate_kbps: f64,
    pub bytes_sent: u64,
    pub fps: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamLogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub codec_name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<String>,
    pub has_audio: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BandwidthSample {
    pub timestamp: i64,
    pub stream_egress_kbps: f64,
    pub host_rx_kbps: f64,
    pub host_tx_kbps: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BandwidthSnapshot {
    pub stream_egress_kbps: f64,
    pub host_rx_kbps: f64,
    pub host_tx_kbps: f64,
    pub total_bytes_sent: u64,
    pub host_rx_bytes_session: u64,
    pub host_tx_bytes_session: u64,
    pub active_streams: usize,
    pub interface_count: usize,
    pub history: Vec<BandwidthSample>,
}

#[derive(Debug, Deserialize)]
pub struct CreateStreamRequest {
    pub name: String,
    pub rtsp_url: String,
    pub rtmp_url: String,
    #[serde(default)]
    pub skip_probe: bool,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateStreamRequest {
    pub name: Option<String>,
    pub rtsp_url: Option<String>,
    pub rtmp_url: Option<String>,
    pub enabled: Option<bool>,
}
