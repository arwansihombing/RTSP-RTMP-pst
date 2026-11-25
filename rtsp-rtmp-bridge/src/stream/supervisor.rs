use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use chrono::Utc;
use sqlx::SqlitePool;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Child,
    sync::{watch, RwLock},
    time::{sleep, timeout},
};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    db,
    models::{StreamLogEntry, StreamStatus},
    stream::ffmpeg::{classify_stderr_line, parse_bitrate_kbps, spawn_ffmpeg_process, StderrSeverity},
};

pub const BACKOFF_SECONDS: [u64; 5] = [3, 5, 10, 30, 60];
pub const MAX_RETRIES: u32 = 10;
pub const MAX_LOG_LINES: usize = 200;

pub struct StreamRuntime {
    pub status: StreamStatus,
    pub pid: Option<u32>,
    pub started_at: Option<Instant>,
    pub retry_count: u32,
    pub last_error: Option<String>,
    pub bitrate_kbps: f64,
    pub bytes_sent: u64,
    pub bytes_sent_prior: u64,
    pub fps: Option<f64>,
    pub logs: VecDeque<StreamLogEntry>,
    pub stop_tx: Option<watch::Sender<bool>>,
    pub join_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Default for StreamRuntime {
    fn default() -> Self {
        Self {
            status: StreamStatus::Stopped,
            pid: None,
            started_at: None,
            retry_count: 0,
            last_error: None,
            bitrate_kbps: 0.0,
            bytes_sent: 0,
            bytes_sent_prior: 0,
            fps: None,
            logs: VecDeque::with_capacity(MAX_LOG_LINES),
            stop_tx: None,
            join_handle: None,
        }
    }
}

impl StreamRuntime {
    pub fn push_log(&mut self, level: &str, message: impl Into<String>) {
        let msg = message.into();
        let trimmed = msg.trim();
        if trimmed.is_empty() {
            return;
        }
        if self.logs.len() >= MAX_LOG_LINES {
            self.logs.pop_front();
        }
        self.logs.push_back(StreamLogEntry {
            timestamp: Utc::now().to_rfc3339(),
            level: level.to_string(),
            message: trimmed.to_string(),
        });
    }
}

pub fn backoff_for_retry(retry_count: u32) -> Duration {
    let idx = retry_count
        .saturating_sub(1)
        .min((BACKOFF_SECONDS.len() - 1) as u32) as usize;
    Duration::from_secs(BACKOFF_SECONDS[idx])
}

async fn terminate_child_gracefully(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }

    #[cfg(not(unix))]
    let _ = child.start_kill();

    match timeout(Duration::from_secs(5), child.wait()).await {
        Ok(_) => {}
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

pub async fn run_supervisor(
    id: Uuid,
    pool: SqlitePool,
    ffmpeg_path: String,
    runtimes: Arc<RwLock<HashMap<Uuid, StreamRuntime>>>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut retry_count: u32 = 0;

    loop {
        if *stop_rx.borrow() {
            let mut guard = runtimes.write().await;
            if let Some(rt) = guard.get_mut(&id) {
                rt.status = StreamStatus::Stopped;
                rt.pid = None;
                rt.started_at = None;
                rt.bitrate_kbps = 0.0;
                rt.fps = None;
            }
            break;
        }

        let record = match db::get_stream(&pool, id).await {
            Ok(Some(rec)) => rec,
            _ => break,
        };

        {
            let mut guard = runtimes.write().await;
            let rt = guard.entry(id).or_default();
            rt.status = if retry_count > 0 {
                StreamStatus::Reconnecting
            } else {
                StreamStatus::Starting
            };
            rt.retry_count = retry_count;
            rt.push_log(
                "info",
                format!(
                    "Spawning FFmpeg passthrough (-c:v copy -an -map 0:v:0) for '{}'",
                    record.name
                ),
            );
        }

        let spawn_time = Instant::now();
        let mut child = match spawn_ffmpeg_process(&ffmpeg_path, &record.rtsp_url, &record.rtmp_url)
        {
            Ok(c) => c,
            Err(err) => {
                retry_count += 1;
                let mut guard = runtimes.write().await;
                let rt = guard.entry(id).or_default();
                rt.last_error = Some(err.clone());
                rt.retry_count = retry_count;
                rt.bitrate_kbps = 0.0;
                rt.fps = None;
                rt.push_log("error", err);

                if retry_count > MAX_RETRIES {
                    rt.status = StreamStatus::Error;
                    rt.push_log("error", "Max retries reached; entering error state");
                    break;
                }
                rt.status = StreamStatus::Reconnecting;
                drop(guard);

                let delay = backoff_for_retry(retry_count);
                tokio::select! {
                    _ = sleep(delay) => continue,
                    _ = stop_rx.changed() => break,
                }
            }
        };

        let child_pid = child.id();
        {
            let mut guard = runtimes.write().await;
            let rt = guard.entry(id).or_default();
            rt.status = StreamStatus::Running;
            rt.pid = child_pid;
            rt.started_at = Some(spawn_time);
        }

        if let Some(stdout) = child.stdout.take() {
            let bw_runtimes = Arc::clone(&runtimes);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                let mut pending_bitrate: Option<f64> = None;
                let mut pending_size: Option<u64> = None;
                let mut pending_fps: Option<f64> = None;

                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some((k, v)) = line.split_once('=') {
                        match k.trim() {
                            "bitrate" => pending_bitrate = parse_bitrate_kbps(v),
                            "total_size" => pending_size = v.trim().parse::<u64>().ok(),
                            "fps" => pending_fps = v.trim().parse::<f64>().ok(),
                            "progress" => {
                                let mut guard = bw_runtimes.write().await;
                                if let Some(rt) = guard.get_mut(&id) {
                                    if let Some(sz) = pending_size {
                                        rt.bytes_sent = rt.bytes_sent_prior.saturating_add(sz);
                                    }
                                    if let Some(br) = pending_bitrate {
                                        rt.bitrate_kbps = (br * 10.0).round() / 10.0;
                                    }
                                    if let Some(fps) = pending_fps {
                                        rt.fps = Some(fps);
                                    }
                                }
                                pending_bitrate = None;
                                pending_size = None;
                                pending_fps = None;
                            }
                            _ => {}
                        }
                    }
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let log_runtimes = Arc::clone(&runtimes);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let severity = classify_stderr_line(&line);
                    let level = match severity {
                        StderrSeverity::Warn => "warn",
                        StderrSeverity::Error => "error",
                        StderrSeverity::Critical => "critical",
                    };
                    if severity == StderrSeverity::Critical {
                        error!(stream_id = %id, "CRITICAL FFmpeg stderr: {line}");
                    } else if severity == StderrSeverity::Error {
                        warn!(stream_id = %id, "FFmpeg error: {line}");
                    }
                    let mut guard = log_runtimes.write().await;
                    if let Some(rt) = guard.get_mut(&id) {
                        if matches!(severity, StderrSeverity::Error | StderrSeverity::Critical) {
                            rt.last_error = Some(line.clone());
                        }
                        rt.push_log(level, line);
                    }
                }
            });
        }

        let mut manual_stop = false;
        let exit_status = tokio::select! {
            res = child.wait() => Some(res),
            _ = stop_rx.changed() => {
                manual_stop = true;
                terminate_child_gracefully(&mut child).await;
                None
            }
        };

        let elapsed = spawn_time.elapsed();
        {
            let mut guard = runtimes.write().await;
            if let Some(rt) = guard.get_mut(&id) {
                rt.pid = None;
                rt.started_at = None;
                rt.bitrate_kbps = 0.0;
                rt.fps = None;
                rt.bytes_sent_prior = rt.bytes_sent;
            }
        }

        if manual_stop || *stop_rx.borrow() {
            let mut guard = runtimes.write().await;
            if let Some(rt) = guard.get_mut(&id) {
                rt.status = StreamStatus::Stopped;
                rt.push_log("info", "Stream stopped by operator");
            }
            info!(stream_id = %id, "Stream stopped cleanly");
            break;
        }

        if elapsed > Duration::from_secs(60) {
            retry_count = 0;
        }
        retry_count += 1;

        let exit_desc = match exit_status {
            Some(Ok(st)) => format!("FFmpeg exited with status {st}"),
            Some(Err(e)) => format!("FFmpeg wait error: {e}"),
            None => "FFmpeg terminated".to_string(),
        };

        if retry_count > MAX_RETRIES {
            let mut guard = runtimes.write().await;
            if let Some(rt) = guard.get_mut(&id) {
                rt.status = StreamStatus::Error;
                rt.retry_count = retry_count;
                rt.last_error = Some(exit_desc.clone());
                rt.push_log("error", format!("{exit_desc}; max retries reached"));
            }
            break;
        }

        let delay = backoff_for_retry(retry_count);
        {
            let mut guard = runtimes.write().await;
            if let Some(rt) = guard.get_mut(&id) {
                rt.status = StreamStatus::Reconnecting;
                rt.retry_count = retry_count;
                rt.last_error = Some(exit_desc.clone());
                rt.push_log(
                    "warn",
                    format!(
                        "{exit_desc}; reconnecting in {}s ({retry_count}/{MAX_RETRIES})",
                        delay.as_secs()
                    ),
                );
            }
        }

        tokio::select! {
            _ = sleep(delay) => {},
            _ = stop_rx.changed() => {
                let mut guard = runtimes.write().await;
                if let Some(rt) = guard.get_mut(&id) {
                    rt.status = StreamStatus::Stopped;
                }
                break;
            }
        }
    }
}
