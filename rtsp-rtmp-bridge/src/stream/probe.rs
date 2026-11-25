use std::{process::Stdio, time::Duration};
use serde::Deserialize;
use tokio::{process::Command, time::timeout};

use crate::{models::ProbeResult, stream::ffmpeg::validate_url};

pub const NON_H264_MESSAGE: &str = "Codec bukan H.264, butuh transcoding — tidak didukung";

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
}

pub async fn probe_rtsp_stream(ffprobe_path: &str, rtsp_url: &str) -> Result<ProbeResult, String> {
    let safe_rtsp = validate_url(rtsp_url, &["rtsp", "rtsps"])?;

    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-rtsp_transport",
        "tcp",
        &safe_rtsp,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = timeout(Duration::from_secs(12), cmd.output())
        .await
        .map_err(|_| "FFprobe timed out after 12s connecting to RTSP source".to_string())?
        .map_err(|e| format!("Failed to execute ffprobe: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(ProbeResult {
            ok: false,
            codec_name: None,
            width: None,
            height: None,
            fps: None,
            has_audio: false,
            message: if stderr.is_empty() {
                "FFprobe failed to open RTSP stream".to_string()
            } else {
                format!("FFprobe failed: {stderr}")
            },
        });
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse FFprobe JSON: {e}"))?;

    let has_audio = parsed
        .streams
        .iter()
        .any(|s| s.codec_type.as_deref() == Some("audio"));

    let Some(video) = parsed
        .streams
        .into_iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
    else {
        return Ok(ProbeResult {
            ok: false,
            codec_name: None,
            width: None,
            height: None,
            fps: None,
            has_audio,
            message: "No video stream found in RTSP source".to_string(),
        });
    };

    let codec_name = video.codec_name.clone();
    let fps = video
        .avg_frame_rate
        .filter(|r| r != "0/0")
        .or(video.r_frame_rate);

    if codec_name.as_deref().map(|c| c.eq_ignore_ascii_case("h264")) != Some(true) {
        let detected = codec_name.clone().unwrap_or_else(|| "unknown".to_string());
        return Ok(ProbeResult {
            ok: false,
            codec_name,
            width: video.width,
            height: video.height,
            fps,
            has_audio,
            message: format!("{NON_H264_MESSAGE} (detected: {detected})"),
        });
    }

    Ok(ProbeResult {
        ok: true,
        codec_name: Some("h264".to_string()),
        width: video.width,
        height: video.height,
        fps,
        has_audio,
        message: if has_audio {
            "H.264 video verified (audio present, stripped via -an)".to_string()
        } else {
            "H.264 video verified (no audio track, DVR passthrough ready)".to_string()
        },
    })
}
