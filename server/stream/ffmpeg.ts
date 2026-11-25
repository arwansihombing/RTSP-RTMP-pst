export type StderrSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface ClassifiedStderr {
  severity: StderrSeverity;
  shouldRestart: boolean;
  summary: string | null;
}

export interface FfmpegProgressBlock {
  bitrateKbps: number | null;
  totalSizeBytes: number | null;
  fps: number | null;
}

const CONTROL_CHAR_PATTERN = /[\r\n\0]/;

export function validateStreamUrl(rawUrl: string, expectedSchemes: readonly string[]): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL cannot be empty');
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    throw new Error('URL contains invalid control characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL format: ${trimmed}`);
  }

  if (!expectedSchemes.includes(parsed.protocol)) {
    throw new Error(`URL must start with ${expectedSchemes.map((s) => `${s}//`).join(' or ')}`);
  }

  if (!parsed.hostname) {
    throw new Error('URL must include a hostname');
  }

  return trimmed;
}

/**
 * Builds the exact zero-transcoding FFmpeg passthrough argument vector for
 * audio-less H.264 CCTV DVR streams -> YouTube Live RTMP, with -progress pipe:1
 * for real-time bitrate and byte throughput telemetry.
 *
 * Never uses -map 0:a or -c:a.
 */
export function buildFfmpegArgs(rtspUrl: string, rtmpUrl: string): string[] {
  const safeRtsp = validateStreamUrl(rtspUrl, ['rtsp:', 'rtsps:']);
  const safeRtmp = validateStreamUrl(rtmpUrl, ['rtmp:', 'rtmps:']);

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-rtsp_transport',
    'tcp',
    '-fflags',
    '+genpts',
    '-i',
    safeRtsp,
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-an',
    '-f',
    'flv',
    '-flvflags',
    'no_duration_filesize',
    '-progress',
    'pipe:1',
    safeRtmp,
  ];
}

export function parseBitrateValue(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'n/a') {
    return null;
  }
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*(k|m|g)?bits\/s$/);
  if (!match) {
    return null;
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  const unit = match[2] ?? '';
  if (unit === 'g') return num * 1_000_000;
  if (unit === 'm') return num * 1_000;
  if (unit === 'k') return num;
  return num / 1_000;
}

export function parseFfmpegProgressFields(fields: Record<string, string>): FfmpegProgressBlock {
  const bitrateKbps = fields.bitrate !== undefined ? parseBitrateValue(fields.bitrate) : null;

  let totalSizeBytes: number | null = null;
  if (fields.total_size !== undefined && fields.total_size.trim().toLowerCase() !== 'n/a') {
    const parsedSize = Number(fields.total_size.trim());
    if (Number.isFinite(parsedSize) && parsedSize >= 0) {
      totalSizeBytes = parsedSize;
    }
  }

  let fps: number | null = null;
  if (fields.fps !== undefined) {
    const parsedFps = Number(fields.fps.trim());
    if (Number.isFinite(parsedFps) && parsedFps >= 0) {
      fps = parsedFps;
    }
  }

  return { bitrateKbps, totalSizeBytes, fps };
}

export function classifyFfmpegStderr(line: string): ClassifiedStderr {
  const lower = line.toLowerCase();

  if (line.includes("Stream map '0:a' matches no streams") || lower.includes('matches no streams')) {
    return {
      severity: 'critical',
      shouldRestart: true,
      summary: 'CRITICAL: Audio stream map error detected (expected -an and -map 0:v:0 only)',
    };
  }

  if (lower.includes('non-monotonous dts')) {
    return {
      severity: 'warn',
      shouldRestart: false,
      summary: 'Non-monotonous DTS warning (handled via -fflags +genpts)',
    };
  }

  if (
    lower.includes('connection refused') ||
    lower.includes('timed out') ||
    lower.includes('operation timed out') ||
    lower.includes('broken pipe') ||
    lower.includes('end of file') ||
    lower.includes('server returned 4') ||
    lower.includes('server returned 5') ||
    lower.includes('input/output error')
  ) {
    return {
      severity: 'error',
      shouldRestart: true,
      summary: line.trim(),
    };
  }

  if (lower.includes('error') || lower.includes('failed') || lower.includes('invalid')) {
    return {
      severity: 'error',
      shouldRestart: false,
      summary: line.trim(),
    };
  }

  return {
    severity: 'warn',
    shouldRestart: false,
    summary: null,
  };
}
