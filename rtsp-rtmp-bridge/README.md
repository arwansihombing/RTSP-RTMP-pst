# rtsp-rtmp-bridge

Zero-transcoding multi-stream RTSP (H.264, no audio) to YouTube Live RTMP passthrough bridge written in Rust (`axum` + `tokio` + `sqlx` + `sqlite`).

## Prerequisites
- Rust toolchain (`cargo`, `rustc` >= 1.78)
- `ffmpeg` and `ffprobe` available on `PATH`

## Run (Zero-Config)
No `.env` file or environment variables required. Hardcoded settings:
- Port: `3000`
- SQLite DB: `./data.db` (auto-created)
- FFmpeg binary: `ffmpeg`
- FFprobe binary: `ffprobe`
- Log level: `info`

```bash
cargo run --release
```
Open `http://localhost:3000`.
