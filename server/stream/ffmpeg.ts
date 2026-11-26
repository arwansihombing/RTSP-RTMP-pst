export type StderrSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface ClassifiedStderr {
  severity: StderrSeverity;
  shouldRestart: boolean;
  fatalNoRetry: boolean;
  summary: string | null;
}

export interface FfmpegProgressBlock {
  bitrateKbps: number | null;
  totalSizeBytes: number | null;
  fps: number | null;
}

export const YOUTUBE_FATAL_RTMP_MESSAGE =
  'Stream key YouTube ditolak atau sudah dipakai stream lain. Periksa Stream Key di YouTube Studio.';

export const FFMPEG_PASSTHROUGH_FLAGS = {
  bannerAndLog: ['-hide_banner', '-loglevel', 'warning'] as const,
  rtspInput: [
    '-rtsp_transport',
    'tcp',
    '-use_wallclock_as_timestamps',
    '1',
    '-fflags',
    '+genpts',
  ] as const,
  videoCopyNoAudio: [
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-an',
    '-avoid_negative_ts',
    'make_zero',
  ] as const,
  flvOutput: [
    '-f',
    'flv',
    '-flvflags',
    'no_duration_filesize',
    '-max_interleave_delta',
    '0',
    '-progress',
    'pipe:1',
  ] as const,
} as const;

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
    ...FFMPEG_PASSTHROUGH_FLAGS.bannerAndLog,
    ...FFMPEG_PASSTHROUGH_FLAGS.rtspInput,
    '-i',
    safeRtsp,
    ...FFMPEG_PASSTHROUGH_FLAGS.videoCopyNoAudio,
    ...FFMPEG_PASSTHROUGH_FLAGS.flvOutput,
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

export function isFatalRtmpStderr(lowerLine: string): boolean {
  return (
    lowerLine.includes('netstream.publish.badname') ||
    lowerLine.includes('netstream.publish.rejected') ||
    lowerLine.includes('http error 401') ||
    lowerLine.includes('http error 403') ||
    lowerLine.includes('server returned 401') ||
    lowerLine.includes('server returned 403') ||
    lowerLine.includes('alreadypublishing') ||
    lowerLine.includes('server error: unauthorized')
  );
}

export function classifyFfmpegStderr(line: string): ClassifiedStderr {
  const lower = line.toLowerCase();

  if (isFatalRtmpStderr(lower)) {
    return {
      severity: 'error',
      shouldRestart: false,
      fatalNoRetry: true,
      summary: YOUTUBE_FATAL_RTMP_MESSAGE,
    };
  }

  if (line.includes("Stream map '0:a' matches no streams") || lower.includes('matches no streams')) {
    return {
      severity: 'critical',
      shouldRestart: true,
      fatalNoRetry: false,
      summary: 'CRITICAL: Audio stream map error detected (expected -an and -map 0:v:0 only)',
    };
  }

  if (lower.includes('non-monotonous dts') || lower.includes('timestamps are unset')) {
    return {
      severity: 'warn',
      shouldRestart: false,
      fatalNoRetry: false,
      summary: 'Timestamp warning from DVR stream (normalized via wallclock/genpts)',
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
      fatalNoRetry: false,
      summary: line.trim(),
    };
  }

  if (lower.includes('error') || lower.includes('failed') || lower.includes('invalid')) {
    return {
      severity: 'error',
      shouldRestart: false,
      fatalNoRetry: false,
      summary: line.trim(),
    };
  }

  return {
    severity: 'warn',
    shouldRestart: false,
    fatalNoRetry: false,
    summary: null,
  };
}
