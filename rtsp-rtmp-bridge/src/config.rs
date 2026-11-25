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

fn resolve_port() -> u16 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(val) = arg.strip_prefix("--port=") {
            if let Ok(parsed) = val.parse::<u16>() {
                if parsed >= 1 {
                    return parsed;
                }
            }
        } else if (arg == "--port" || arg == "-p") && i + 1 < args.len() {
            if let Ok(parsed) = args[i + 1].parse::<u16>() {
                if parsed >= 1 {
                    return parsed;
                }
            }
        }
        i += 1;
    }
    PORT
}

impl AppConfig {
    pub fn load() -> Self {
        Self {
            database_url: format!("sqlite://{DB_PATH}?mode=rwc"),
            ffmpeg_path: FFMPEG_PATH.to_string(),
            ffprobe_path: FFPROBE_PATH.to_string(),
            port: resolve_port(),
            rust_log: LOG_LEVEL.to_string(),
        }
    }
}
