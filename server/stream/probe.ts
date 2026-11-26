import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateStreamUrl } from './ffmpeg';
import { maskCommandUrls } from './mask';
import type { ProbeResult } from './types';

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
}

export const NON_H264_ERROR = 'Codec bukan H.264, butuh transcoding — tidak didukung';

export function parseFfprobeJson(rawJson: string): ProbeResult {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(rawJson) as FfprobeOutput;
  } catch {
    return {
      ok: false,
      codec_name: null,
      width: null,
      height: null,
      fps: null,
      has_audio: false,
      message: 'Failed to parse FFprobe JSON output',
    };
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');

  if (!video) {
    return {
      ok: false,
      codec_name: null,
      width: null,
      height: null,
      fps: null,
      has_audio: hasAudio,
      message: 'No video stream found in RTSP source',
    };
  }

  const codec = (video.codec_name ?? '').toLowerCase();
  const fps = video.avg_frame_rate && video.avg_frame_rate !== '0/0'
    ? video.avg_frame_rate
    : video.r_frame_rate ?? null;

  if (codec !== 'h264') {
    return {
      ok: false,
      codec_name: video.codec_name ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      fps,
      has_audio: hasAudio,
      message: `${NON_H264_ERROR} (detected: ${video.codec_name ?? 'unknown'})`,
    };
  }

  return {
    ok: true,
    codec_name: 'h264',
    width: video.width ?? null,
    height: video.height ?? null,
    fps,
    has_audio: hasAudio,
    message: hasAudio
      ? 'H.264 video verified (audio track present, will be stripped via -an)'
      : 'H.264 video verified (no audio track, DVR passthrough ready)',
  };
}

export async function probeRtspStream(
  ffprobePath: string,
  rtspUrl: string,
  timeoutMs = 12_000,
): Promise<ProbeResult> {
  const safeRtsp = validateStreamUrl(rtspUrl, ['rtsp:', 'rtsps:']);

  const args = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-rtsp_transport',
    'tcp',
    safeRtsp,
  ];

  try {
    const { stdout } = await execFileAsync(ffprobePath, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return parseFfprobeJson(stdout);
  } catch (err) {
    const error = err as Error & { killed?: boolean; stderr?: string };
    if (error.killed) {
      return {
        ok: false,
        codec_name: null,
        width: null,
        height: null,
        fps: null,
        has_audio: false,
        message: `FFprobe timed out after ${Math.round(timeoutMs / 1000)}s connecting to RTSP source`,
      };
    }

    const rawDetail = (error.stderr || error.message || 'FFprobe connection failed').trim();
    const detail = maskCommandUrls(rawDetail);
    return {
      ok: false,
      codec_name: null,
      width: null,
      height: null,
      fps: null,
      has_audio: false,
      message: `FFprobe failed: ${detail}`,
    };
  }
}
