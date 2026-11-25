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

export function resolvePort(argv: readonly string[] = process.argv.slice(2)): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
        return parsed;
      }
    } else if ((arg === '--port' || arg === '-p') && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
        return parsed;
      }
    }
  }
  return PORT;
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2)): AppConfig {
  return {
    port: resolvePort(argv),
    dbPath: DB_PATH,
    ffmpegPath: FFMPEG_PATH,
    ffprobePath: FFPROBE_PATH,
    rustLog: LOG_LEVEL,
  };
}
