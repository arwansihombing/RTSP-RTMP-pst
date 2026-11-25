use std::{collections::{HashMap, VecDeque}, sync::Arc, time::Instant};
use chrono::Utc;
use sqlx::SqlitePool;
use tokio::sync::{watch, RwLock};
use uuid::Uuid;

use crate::{
    config::AppConfig,
    db,
    error::AppError,
    models::{
        BandwidthSample, BandwidthSnapshot, CreateStreamRequest, ProbeResult, StreamLogEntry,
        StreamRecord, StreamStatus, StreamView, UpdateStreamRequest,
    },
    stream::{
        ffmpeg::validate_url,
        probe::probe_rtsp_stream,
        supervisor::{run_supervisor, StreamRuntime},
    },
};

#[derive(Clone)]
pub struct StreamManager {
    pub pool: SqlitePool,
    pub config: AppConfig,
    pub runtimes: Arc<RwLock<HashMap<Uuid, StreamRuntime>>>,
    pub bw_history: Arc<RwLock<VecDeque<BandwidthSample>>>,
}

impl StreamManager {
    pub fn new(pool: SqlitePool, config: AppConfig) -> Self {
        let manager = Self {
            pool,
            config,
            runtimes: Arc::new(RwLock::new(HashMap::new())),
            bw_history: Arc::new(RwLock::new(VecDeque::with_capacity(60))),
        };
        manager.spawn_bandwidth_sampler();
        manager
    }

    fn spawn_bandwidth_sampler(&self) {
        let runtimes = Arc::clone(&self.runtimes);
        let history = Arc::clone(&self.bw_history);
        tokio::spawn(async move {
            let mut prev: Option<(u64, u64, Instant)> = None;
            loop {
                let (rx_total, tx_total, _ifaces) = read_proc_net_dev().await;
                let now = Instant::now();
                let (mut host_rx_kbps, mut host_tx_kbps) = (0.0, 0.0);
                if let Some((prx, ptx, pts)) = prev {
                    let dt = now.duration_since(pts).as_secs_f64().max(0.2);
                    host_rx_kbps = ((rx_total.saturating_sub(prx) as f64) * 8.0 / 1000.0 / dt * 10.0).round() / 10.0;
                    host_tx_kbps = ((tx_total.saturating_sub(ptx) as f64) * 8.0 / 1000.0 / dt * 10.0).round() / 10.0;
                }
                prev = Some((rx_total, tx_total, now));

                let stream_egress_kbps = {
                    let guard = runtimes.read().await;
                    let sum: f64 = guard
                        .values()
                        .filter(|r| r.status == StreamStatus::Running)
                        .map(|r| r.bitrate_kbps)
                        .sum();
                    (sum * 10.0).round() / 10.0
                };

                let mut hist = history.write().await;
                if hist.len() >= 60 {
                    hist.pop_front();
                }
                hist.push_back(BandwidthSample {
                    timestamp: Utc::now().timestamp_millis(),
                    stream_egress_kbps,
                    host_rx_kbps,
                    host_tx_kbps,
                });
                drop(hist);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    }

    pub async fn get_bandwidth(&self) -> BandwidthSnapshot {
        let guard = self.runtimes.read().await;
        let mut active_streams = 0;
        let mut stream_egress_kbps = 0.0;
        let mut total_bytes_sent = 0u64;
        for r in guard.values() {
            if r.status == StreamStatus::Running {
                active_streams += 1;
                stream_egress_kbps += r.bitrate_kbps;
            }
            total_bytes_sent = total_bytes_sent.saturating_add(r.bytes_sent);
        }
        drop(guard);

        let (_rx, _tx, interface_count) = read_proc_net_dev().await;
        let hist = self.bw_history.read().await;
        let latest = hist.back();

        BandwidthSnapshot {
            stream_egress_kbps: (stream_egress_kbps * 10.0).round() / 10.0,
            host_rx_kbps: latest.map(|s| s.host_rx_kbps).unwrap_or(0.0),
            host_tx_kbps: latest.map(|s| s.host_tx_kbps).unwrap_or(0.0),
            total_bytes_sent,
            host_rx_bytes_session: 0,
            host_tx_bytes_session: 0,
            active_streams,
            interface_count,
            history: hist.iter().cloned().collect(),
        }
    }

    async fn to_view(&self, rec: StreamRecord) -> Result<StreamView, AppError> {
        let id = Uuid::parse_str(&rec.id).map_err(|e| AppError::Internal(e.into()))?;
        let guard = self.runtimes.read().await;
        let rt = guard.get(&id);

        let (status, pid, uptime_seconds, retry_count, last_error, bitrate_kbps, bytes_sent, fps) =
            match rt {
                Some(r) => {
                    let uptime = if r.status == StreamStatus::Running {
                        r.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0)
                    } else {
                        0
                    };
                    (
                        r.status,
                        r.pid,
                        uptime,
                        r.retry_count,
                        r.last_error.clone(),
                        if r.status == StreamStatus::Running {
                            r.bitrate_kbps
                        } else {
                            0.0
                        },
                        r.bytes_sent,
                        if r.status == StreamStatus::Running {
                            r.fps
                        } else {
                            None
                        },
                    )
                }
                None => (StreamStatus::Stopped, None, 0, 0, None, 0.0, 0, None),
            };

        Ok(StreamView {
            id,
            name: rec.name,
            rtsp_url: rec.rtsp_url,
            rtmp_url: rec.rtmp_url,
            enabled: rec.enabled == 1,
            status,
            pid,
            uptime_seconds,
            retry_count,
            last_error,
            bitrate_kbps,
            bytes_sent,
            fps,
            created_at: rec.created_at,
            updated_at: rec.updated_at,
        })
    }

    pub async fn list_streams(&self) -> Result<Vec<StreamView>, AppError> {
        let records = db::list_streams(&self.pool).await?;
        let mut views = Vec::with_capacity(records.len());
        for rec in records {
            views.push(self.to_view(rec).await?);
        }
        Ok(views)
    }

    pub async fn create_stream(
        &self,
        req: CreateStreamRequest,
    ) -> Result<(StreamView, Option<ProbeResult>), AppError> {
        if req.name.trim().is_empty() {
            return Err(AppError::BadRequest("name is required".to_string()));
        }
        let safe_rtsp = validate_url(&req.rtsp_url, &["rtsp", "rtsps"])
            .map_err(AppError::BadRequest)?;
        let safe_rtmp = validate_url(&req.rtmp_url, &["rtmp", "rtmps"])
            .map_err(AppError::BadRequest)?;

        let probe = if !req.skip_probe {
            let res = probe_rtsp_stream(&self.config.ffprobe_path, &safe_rtsp)
                .await
                .map_err(AppError::Unprocessable)?;
            if !res.ok {
                return Err(AppError::Unprocessable(res.message));
            }
            Some(res)
        } else {
            None
        };

        let record = db::insert_stream(&self.pool, &req.name, &safe_rtsp, &safe_rtmp, true).await?;
        let id = Uuid::parse_str(&record.id).map_err(|e| AppError::Internal(e.into()))?;

        {
            let mut guard = self.runtimes.write().await;
            let rt = guard.entry(id).or_default();
            if let Some(ref p) = probe {
                rt.push_log("info", format!("Stream created ({})", p.message));
            } else {
                rt.push_log("info", "Stream created (FFprobe pre-check skipped)");
            }
        }

        if req.auto_start {
            self.start_stream(id, req.skip_probe).await?;
        }

        let latest = db::get_stream(&self.pool, id)
            .await?
            .ok_or(AppError::NotFound)?;
        Ok((self.to_view(latest).await?, probe))
    }

    pub async fn update_stream(
        &self,
        id: Uuid,
        req: UpdateStreamRequest,
    ) -> Result<StreamView, AppError> {
        if let Some(ref name) = req.name {
            if name.trim().is_empty() {
                return Err(AppError::BadRequest("name cannot be empty".to_string()));
            }
        }
        if let Some(ref rtsp) = req.rtsp_url {
            validate_url(rtsp, &["rtsp", "rtsps"]).map_err(AppError::BadRequest)?;
        }
        if let Some(ref rtmp) = req.rtmp_url {
            validate_url(rtmp, &["rtmp", "rtmps"]).map_err(AppError::BadRequest)?;
        }

        let updated = db::update_stream(
            &self.pool,
            id,
            req.name.as_deref(),
            req.rtsp_url.as_deref(),
            req.rtmp_url.as_deref(),
            req.enabled,
        )
        .await?
        .ok_or(AppError::NotFound)?;

        self.to_view(updated).await
    }

    pub async fn delete_stream(&self, id: Uuid) -> Result<(), AppError> {
        let _ = self.stop_stream(id).await;
        self.runtimes.write().await.remove(&id);
        if !db::delete_stream(&self.pool, id).await? {
            return Err(AppError::NotFound);
        }
        Ok(())
    }

    pub async fn start_stream(&self, id: Uuid, skip_probe: bool) -> Result<StreamView, AppError> {
        let record = db::get_stream(&self.pool, id)
            .await?
            .ok_or(AppError::NotFound)?;

        {
            let guard = self.runtimes.read().await;
            if let Some(rt) = guard.get(&id) {
                if matches!(
                    rt.status,
                    StreamStatus::Running | StreamStatus::Starting | StreamStatus::Reconnecting
                ) {
                    return self.to_view(record).await;
                }
            }
        }

        if !skip_probe {
            let probe = probe_rtsp_stream(&self.config.ffprobe_path, &record.rtsp_url)
                .await
                .map_err(AppError::Unprocessable)?;
            if !probe.ok {
                let mut guard = self.runtimes.write().await;
                let rt = guard.entry(id).or_default();
                rt.status = StreamStatus::Error;
                rt.last_error = Some(probe.message.clone());
                rt.push_log("error", &probe.message);
                return Err(AppError::Unprocessable(probe.message));
            }
        }

        let (stop_tx, stop_rx) = watch::channel(false);
        let pool = self.pool.clone();
        let ffmpeg_path = self.config.ffmpeg_path.clone();
        let runtimes = Arc::clone(&self.runtimes);

        let handle = tokio::spawn(async move {
            run_supervisor(id, pool, ffmpeg_path, runtimes, stop_rx).await;
        });

        {
            let mut guard = self.runtimes.write().await;
            let rt = guard.entry(id).or_default();
            rt.last_error = None;
            rt.stop_tx = Some(stop_tx);
            rt.join_handle = Some(handle);
        }

        self.to_view(record).await
    }

    pub async fn stop_stream(&self, id: Uuid) -> Result<StreamView, AppError> {
        let record = db::get_stream(&self.pool, id)
            .await?
            .ok_or(AppError::NotFound)?;

        let handle = {
            let mut guard = self.runtimes.write().await;
            if let Some(rt) = guard.get_mut(&id) {
                if let Some(tx) = rt.stop_tx.take() {
                    let _ = tx.send(true);
                }
                rt.join_handle.take()
            } else {
                None
            }
        };

        if let Some(jh) = handle {
            let _ = jh.await;
        }

        self.to_view(record).await
    }

    pub async fn probe_stream(&self, id: Uuid) -> Result<ProbeResult, AppError> {
        let record = db::get_stream(&self.pool, id)
            .await?
            .ok_or(AppError::NotFound)?;
        let res = probe_rtsp_stream(&self.config.ffprobe_path, &record.rtsp_url)
            .await
            .map_err(AppError::Unprocessable)?;
        {
            let mut guard = self.runtimes.write().await;
            let rt = guard.entry(id).or_default();
            rt.push_log(if res.ok { "info" } else { "warn" }, &res.message);
        }
        Ok(res)
    }

    pub async fn get_logs(&self, id: Uuid) -> Result<Vec<StreamLogEntry>, AppError> {
        if db::get_stream(&self.pool, id).await?.is_none() {
            return Err(AppError::NotFound);
        }
        let guard = self.runtimes.read().await;
        Ok(guard
            .get(&id)
            .map(|rt| rt.logs.iter().cloned().collect())
            .unwrap_or_default())
    }

    pub async fn stop_all(&self) {
        let ids: Vec<Uuid> = {
            let guard = self.runtimes.read().await;
            guard.keys().copied().collect()
        };
        for id in ids {
            let _ = self.stop_stream(id).await;
        }
    }
}

async fn read_proc_net_dev() -> (u64, u64, usize) {
    let Ok(content) = tokio::fs::read_to_string("/proc/net/dev").await else {
        return (0, 0, 0);
    };
    let mut rx = 0u64;
    let mut tx = 0u64;
    let mut count = 0usize;
    for line in content.lines().skip(2) {
        if let Some((iface, rest)) = line.split_once(':') {
            if iface.trim() == "lo" {
                continue;
            }
            let cols: Vec<&str> = rest.split_whitespace().collect();
            if cols.len() >= 9 {
                if let (Ok(r), Ok(t)) = (cols[0].parse::<u64>(), cols[8].parse::<u64>()) {
                    rx = rx.saturating_add(r);
                    tx = tx.saturating_add(t);
                    count += 1;
                }
            }
        }
    }
    (rx, tx, count)
}
