use std::process::Stdio;
use tokio::process::{Child, Command};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StderrSeverity {
    Warn,
    Error,
    Critical,
}

pub fn validate_url(raw: &str, allowed_schemes: &[&str]) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".to_string());
    }
    if trimmed.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err("URL contains invalid control characters".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    if !allowed_schemes.contains(&parsed.scheme()) {
        return Err(format!(
            "URL must start with {}",
            allowed_schemes
                .iter()
                .map(|s| format!("{s}://"))
                .collect::<Vec<_>>()
                .join(" or ")
        ));
    }
    if parsed.host_str().is_none() {
        return Err("URL must include a hostname".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn build_ffmpeg_args(rtsp_url: &str, rtmp_url: &str) -> Result<Vec<String>, String> {
    let safe_rtsp = validate_url(rtsp_url, &["rtsp", "rtsps"])?;
    let safe_rtmp = validate_url(rtmp_url, &["rtmp", "rtmps"])?;

    Ok(vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-rtsp_transport".to_string(),
        "tcp".to_string(),
        "-use_wallclock_as_timestamps".to_string(),
        "1".to_string(),
        "-fflags".to_string(),
        "+genpts".to_string(),
        "-i".to_string(),
        safe_rtsp,
        "-map".to_string(),
        "0:v:0".to_string(),
        "-c:v".to_string(),
        "copy".to_string(),
        "-an".to_string(),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
        "-f".to_string(),
        "flv".to_string(),
        "-flvflags".to_string(),
        "no_duration_filesize".to_string(),
        "-max_interleave_delta".to_string(),
        "0".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        safe_rtmp,
    ])
}

pub fn parse_bitrate_kbps(raw: &str) -> Option<f64> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed == "n/a" {
        return None;
    }
    if let Some(num) = trimmed.strip_suffix("kbits/s") {
        return num.trim().parse::<f64>().ok();
    }
    if let Some(num) = trimmed.strip_suffix("mbits/s") {
        return num.trim().parse::<f64>().ok().map(|v| v * 1000.0);
    }
    if let Some(num) = trimmed.strip_suffix("bits/s") {
        return num.trim().parse::<f64>().ok().map(|v| v / 1000.0);
    }
    None
}

pub fn spawn_ffmpeg_process(
    ffmpeg_path: &str,
    rtsp_url: &str,
    rtmp_url: &str,
) -> Result<Child, String> {
    let args = build_ffmpeg_args(rtsp_url, rtmp_url)?;
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to spawn FFmpeg binary '{ffmpeg_path}': {e}"))
}

pub fn classify_stderr_line(line: &str) -> StderrSeverity {
    let lower = line.to_lowercase();
    if line.contains("Stream map '0:a' matches no streams") || lower.contains("matches no streams") {
        StderrSeverity::Critical
    } else if lower.contains("non-monotonous dts") || lower.contains("timestamps are unset") {
        StderrSeverity::Warn
    } else if lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("broken pipe")
        || lower.contains("error")
        || lower.contains("failed")
    {
        StderrSeverity::Error
    } else {
        StderrSeverity::Warn
    }
}
