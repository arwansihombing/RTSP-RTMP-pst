pub const DB_PATH: &str = "./data.db";
pub const FFMPEG_PATH: &str = "ffmpeg";
pub const FFPROBE_PATH: &str = "ffprobe";
pub const PORT: u16 = 3000;
pub const LOG_LEVEL: &str = "info";

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub database_url: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub port: u16,
    pub rust_log: String,
}

impl AppConfig {
    pub fn load() -> Self {
        Self {
            database_url: format!("sqlite://{DB_PATH}?mode=rwc"),
            ffmpeg_path: FFMPEG_PATH.to_string(),
            ffprobe_path: FFPROBE_PATH.to_string(),
            port: PORT,
            rust_log: LOG_LEVEL.to_string(),
        }
    }
}
