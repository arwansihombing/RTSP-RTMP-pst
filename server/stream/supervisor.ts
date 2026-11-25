import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { buildFfmpegArgs, classifyFfmpegStderr, parseFfmpegProgressFields } from './ffmpeg';
import type { StreamLogEntry, StreamStatus } from './types';

export const BACKOFF_STEPS_SECONDS = [3, 5, 10, 30, 60] as const;
export const MAX_RETRIES = 10;
export const HEALTHY_UPTIME_RESET_MS = 60_000;
export const MAX_LOG_LINES = 200;

export function getBackoffSeconds(retryCount: number): number {
  if (retryCount <= 1) {
    return BACKOFF_STEPS_SECONDS[0];
  }
  const index = Math.min(retryCount - 1, BACKOFF_STEPS_SECONDS.length - 1);
  return BACKOFF_STEPS_SECONDS[index];
}

export function shouldResetRetries(runDurationMs: number): boolean {
  return runDurationMs > HEALTHY_UPTIME_RESET_MS;
}

export function hasExceededMaxRetries(retryCount: number): boolean {
  return retryCount > MAX_RETRIES;
}

export class StreamLogBuffer {
  private readonly entries: StreamLogEntry[] = [];
  private readonly maxLines: number;

  constructor(maxLines = MAX_LOG_LINES) {
    this.maxLines = maxLines;
  }

  push(level: StreamLogEntry['level'], message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    this.entries.push({
      timestamp: new Date().toISOString(),
      level,
      message: trimmed,
    });
    if (this.entries.length > this.maxLines) {
      this.entries.splice(0, this.entries.length - this.maxLines);
    }
  }

  list(): StreamLogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export interface StreamRuntimeState {
  id: string;
  status: StreamStatus;
  pid: number | null;
  startedAtMs: number | null;
  retryCount: number;
  lastError: string | null;
  bitrateKbps: number;
  bytesSent: number;
  bytesSentPriorRuns: number;
  fps: number | null;
  logs: StreamLogBuffer;
  stopRequested: boolean;
  child: ChildProcess | null;
  sleepTimer: NodeJS.Timeout | null;
  wakeSleep: (() => void) | null;
  loopPromise: Promise<void> | null;
}

export function createInitialRuntime(id: string): StreamRuntimeState {
  return {
    id,
    status: 'stopped',
    pid: null,
    startedAtMs: null,
    retryCount: 0,
    lastError: null,
    bitrateKbps: 0,
    bytesSent: 0,
    bytesSentPriorRuns: 0,
    fps: null,
    logs: new StreamLogBuffer(MAX_LOG_LINES),
    stopRequested: false,
    child: null,
    sleepTimer: null,
    wakeSleep: null,
    loopPromise: null,
  };
}

function interruptibleSleep(runtime: StreamRuntimeState, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (runtime.stopRequested) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      runtime.sleepTimer = null;
      runtime.wakeSleep = null;
      resolve();
    }, ms);
    runtime.sleepTimer = timer;
    runtime.wakeSleep = () => {
      clearTimeout(timer);
      runtime.sleepTimer = null;
      runtime.wakeSleep = null;
      resolve();
    };
  });
}

export async function terminateChildGracefully(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        resolve();
      }
    };

    child.once('close', finish);

    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }

    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore already-exited process
        }
      }
      finish();
    }, timeoutMs);
  });
}

export async function runSupervisorLoop(
  runtime: StreamRuntimeState,
  ffmpegPath: string,
  getConfig: () => { rtsp_url: string; rtmp_url: string; name: string } | null,
): Promise<void> {
  runtime.retryCount = 0;

  while (!runtime.stopRequested) {
    const cfg = getConfig();
    if (!cfg) {
      runtime.status = 'stopped';
      break;
    }

    let args: string[];
    try {
      args = buildFfmpegArgs(cfg.rtsp_url, cfg.rtmp_url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid stream URL configuration';
      runtime.lastError = msg;
      runtime.status = 'error';
      runtime.logs.push('error', msg);
      break;
    }

    runtime.status = runtime.retryCount > 0 ? 'reconnecting' : 'starting';
    runtime.logs.push(
      'info',
      `Spawning FFmpeg passthrough (-c:v copy -an -map 0:v:0) for "${cfg.name}"`,
    );

    const spawnTime = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to spawn FFmpeg process';
      runtime.lastError = msg;
      runtime.bitrateKbps = 0;
      runtime.fps = null;
      runtime.logs.push('error', msg);
      runtime.retryCount += 1;
      if (hasExceededMaxRetries(runtime.retryCount)) {
        runtime.status = 'error';
        runtime.logs.push('error', `Max retries (${MAX_RETRIES}) reached; entering error state`);
        break;
      }
      runtime.status = 'reconnecting';
      const delaySec = getBackoffSeconds(runtime.retryCount);
      await interruptibleSleep(runtime, delaySec * 1000);
      continue;
    }

    runtime.child = child;
    runtime.pid = child.pid ?? null;
    runtime.startedAtMs = spawnTime;
    runtime.status = 'running';

    let currentRunBytes = 0;
    let prevProgressBytes = 0;
    let prevProgressTs = spawnTime;

    if (child.stdout) {
      const progressRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      let pendingFields: Record<string, string> = {};
      progressRl.on('line', (line) => {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) return;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        pendingFields[key] = val;

        if (key === 'progress') {
          const parsed = parseFfmpegProgressFields(pendingFields);
          const nowTs = Date.now();

          if (parsed.totalSizeBytes !== null) {
            currentRunBytes = parsed.totalSizeBytes;
            runtime.bytesSent = runtime.bytesSentPriorRuns + currentRunBytes;
          }

          if (parsed.bitrateKbps !== null) {
            runtime.bitrateKbps = Math.round(parsed.bitrateKbps * 10) / 10;
          } else if (parsed.totalSizeBytes !== null && nowTs > prevProgressTs) {
            const deltaBytes = Math.max(0, parsed.totalSizeBytes - prevProgressBytes);
            const deltaSec = (nowTs - prevProgressTs) / 1000;
            runtime.bitrateKbps = Math.round(((deltaBytes * 8) / 1000 / deltaSec) * 10) / 10;
          }

          if (parsed.totalSizeBytes !== null) {
            prevProgressBytes = parsed.totalSizeBytes;
            prevProgressTs = nowTs;
          }
          if (parsed.fps !== null) {
            runtime.fps = parsed.fps;
          }

          pendingFields = {};
        }
      });
    }

    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const classified = classifyFfmpegStderr(line);
        runtime.logs.push(classified.severity, line);
        if (classified.severity === 'critical') {
          runtime.lastError = classified.summary || line;
        } else if (classified.severity === 'error' && classified.summary) {
          runtime.lastError = classified.summary;
        }
      });
    }

    const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; err?: Error }>(
      (resolve) => {
        child.once('error', (err) => {
          resolve({ code: null, signal: null, err });
        });
        child.once('close', (code, signal) => {
          resolve({ code, signal });
        });
      },
    );

    runtime.child = null;
    runtime.pid = null;
    runtime.bitrateKbps = 0;
    runtime.fps = null;
    runtime.bytesSentPriorRuns += currentRunBytes;
    runtime.bytesSent = runtime.bytesSentPriorRuns;
    const runDurationMs = Date.now() - spawnTime;
    runtime.startedAtMs = null;

    if (runtime.stopRequested) {
      runtime.status = 'stopped';
      runtime.logs.push('info', 'Stream stopped by operator');
      break;
    }

    if (exitResult.err) {
      runtime.lastError = exitResult.err.message;
      runtime.logs.push('error', `FFmpeg process error: ${exitResult.err.message}`);
    } else {
      const exitDesc =
        exitResult.code !== null
          ? `exit code ${exitResult.code}`
          : `signal ${exitResult.signal ?? 'unknown'}`;
      if (!runtime.lastError || exitResult.code !== 0) {
        runtime.lastError = `FFmpeg exited unexpectedly (${exitDesc})`;
      }
      runtime.logs.push('warn', `FFmpeg process terminated (${exitDesc})`);
    }

    if (shouldResetRetries(runDurationMs)) {
      runtime.retryCount = 0;
    }

    runtime.retryCount += 1;
    if (hasExceededMaxRetries(runtime.retryCount)) {
      runtime.status = 'error';
      runtime.logs.push(
        'error',
        `Exceeded ${MAX_RETRIES} reconnect attempts; manual restart required`,
      );
      break;
    }

    runtime.status = 'reconnecting';
    const backoffSec = getBackoffSeconds(runtime.retryCount);
    runtime.logs.push(
      'info',
      `Reconnecting in ${backoffSec}s (attempt ${runtime.retryCount}/${MAX_RETRIES})`,
    );
    await interruptibleSleep(runtime, backoffSec * 1000);
  }
}
