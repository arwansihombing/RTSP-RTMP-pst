export const DB_PATH = './data.db';
export const FFMPEG_PATH = 'ffmpeg';
export const FFPROBE_PATH = 'ffprobe';
export const PORT = 3000;
export const LOG_LEVEL = 'info';

export interface AppConfig {
  port: number;
  dbPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  rustLog: string;
}

export function loadConfig(): AppConfig {
  return {
    port: PORT,
    dbPath: DB_PATH,
    ffmpegPath: FFMPEG_PATH,
    ffprobePath: FFPROBE_PATH,
    rustLog: LOG_LEVEL,
  };
}
