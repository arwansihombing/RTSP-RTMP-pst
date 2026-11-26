import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { maskCommandUrls } from './mask';
export { maskCommandUrls } from './mask';

export interface KnownFfmpegSession {
  streamId: string;
  streamName: string;
}

export interface FfmpegOsSession {
  pid: number;
  ppid: number;
  elapsed_seconds: number;
  managed: boolean;
  stream_id: string | null;
  stream_name: string | null;
  streambridge_signature: boolean;
  command: string;
}

export function parsePsFfmpegProcesses(
  psOutput: string,
  knownByPid: ReadonlyMap<number, KnownFfmpegSession>,
): FfmpegOsSession[] {
  const results: FfmpegOsSession[] = [];
  const lines = psOutput.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const elapsedSeconds = Number.parseInt(match[3], 10);
    const args = match[4].trim();

    if (!Number.isInteger(pid) || pid <= 0) continue;

    const firstToken = args.split(/\s+/)[0] ?? '';
    const binName = path.basename(firstToken).toLowerCase();
    if (binName !== 'ffmpeg' && binName !== 'ffmpeg.exe') {
      continue;
    }

    const known = knownByPid.get(pid);
    const streambridgeSignature =
      args.includes('-rtsp_transport') && args.includes('-f flv') && args.includes('-c:v copy');

    results.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      elapsed_seconds: Number.isInteger(elapsedSeconds) ? elapsedSeconds : 0,
      managed: Boolean(known),
      stream_id: known?.streamId ?? null,
      stream_name: known?.streamName ?? null,
      streambridge_signature: streambridgeSignature,
      command: maskCommandUrls(args),
    });
  }

  return results;
}

export async function inspectOsFfmpegSessions(
  knownByPid: ReadonlyMap<number, KnownFfmpegSession>,
): Promise<FfmpegOsSession[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], {
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    return parsePsFfmpegProcesses(stdout, knownByPid);
  } catch {
    return [];
  }
}

export async function cleanupOrphanFfmpegSessions(
  knownByPid: ReadonlyMap<number, KnownFfmpegSession>,
): Promise<{ killedPids: number[]; sessions: FfmpegOsSession[] }> {
  const before = await inspectOsFfmpegSessions(knownByPid);
  const targets = before.filter(
    (proc) => !proc.managed && (proc.streambridge_signature || proc.command.includes('rtmp')),
  );

  const killedPids: number[] = [];
  for (const proc of targets) {
    try {
      process.kill(proc.pid, 'SIGTERM');
      killedPids.push(proc.pid);
    } catch {
      // process already exited
    }
  }

  if (killedPids.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (const pid of killedPids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        // already exited cleanly
      }
    }
  }

  const after = await inspectOsFfmpegSessions(knownByPid);
  return { killedPids, sessions: after };
}
