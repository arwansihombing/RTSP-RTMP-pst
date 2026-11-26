import type { AppConfig } from '../config';
import type { CreateStreamInput, StreamDatabase, UpdateStreamInput } from '../db';
import { BandwidthMonitor } from './bandwidth';
import { validateStreamUrl } from './ffmpeg';
import { maskCommandUrls, maskRtmpUrl, maskRtspUrl } from './mask';
import { probeRtspStream } from './probe';
import {
  cleanupOrphanFfmpegSessions,
  inspectOsFfmpegSessions,
  type FfmpegOsSession,
  type KnownFfmpegSession,
} from './sessions';
import {
  createInitialRuntime,
  runSupervisorLoop,
  terminateChildGracefully,
  type StreamRuntimeState,
} from './supervisor';
import type { BandwidthSnapshot, ProbeResult, StreamLogEntry, StreamRecord, StreamView } from './types';

const PLACEHOLDER_KEY = 'REPLACE_STREAM_KEY';

export function resolveEditedRtspUrl(submittedUrl: string, existingUrl: string): string {
  const trimmed = submittedUrl.trim();
  if (!trimmed) {
    return existingUrl;
  }
  const maskedMatch = trimmed.match(/^(rtsps?:\/\/)([^:/@\s]+):\*\*\*\*@(.+)$/i);
  if (maskedMatch) {
    const existingMatch = existingUrl.match(/^(rtsps?:\/\/)([^:/@\s]+):([^\s/@]+)@(.+)$/i);
    if (existingMatch && existingMatch[2] === maskedMatch[2]) {
      return `${maskedMatch[1]}${maskedMatch[2]}:${existingMatch[3]}@${maskedMatch[3]}`;
    }
    if (trimmed === maskRtspUrl(existingUrl)) {
      return existingUrl;
    }
    throw new Error('Masukkan password RTSP asli atau biarkan field RTSP tidak diubah.');
  }
  return validateStreamUrl(trimmed, ['rtsp:', 'rtsps:']);
}

export function stripRtmpStreamKey(rtmpUrl: string): string {
  const match = rtmpUrl.match(/^(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)/i);
  if (match) {
    return match[1];
  }
  return rtmpUrl;
}

export function needsStreamKey(rtmpUrl: string): boolean {
  const trimmed = rtmpUrl.trim();
  return !trimmed || trimmed.endsWith('/') || trimmed.endsWith(PLACEHOLDER_KEY);
}

export interface ExportedStreamItem {
  name: string;
  rtsp_url: string;
  rtmp_ingest: string;
  enabled: boolean;
  auto_start: boolean;
}

export interface ImportStreamItem {
  name?: unknown;
  rtsp_url?: unknown;
  rtmp_url?: unknown;
  rtmp_ingest?: unknown;
  enabled?: unknown;
  auto_start?: unknown;
}

export class StreamManager {
  private readonly runtimes = new Map<string, StreamRuntimeState>();
  private readonly startingIds = new Set<string>();
  private readonly bandwidthMonitor: BandwidthMonitor;

  constructor(
    private readonly db: StreamDatabase,
    private readonly config: AppConfig,
  ) {
    for (const record of this.db.listStreams()) {
      this.runtimes.set(record.id, createInitialRuntime(record.id));
    }

    this.bandwidthMonitor = new BandwidthMonitor(() => {
      let egressKbps = 0;
      let totalBytesSent = 0;
      let activeStreams = 0;
      for (const rt of this.runtimes.values()) {
        if (rt.status === 'running') {
          activeStreams += 1;
          egressKbps += rt.bitrateKbps;
        }
        totalBytesSent += rt.bytesSent;
      }
      return { egressKbps, totalBytesSent, activeStreams };
    });
    this.bandwidthMonitor.start();
  }

  private getOrCreateRuntime(id: string): StreamRuntimeState {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = createInitialRuntime(id);
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private isSessionActive(id: string, rt: StreamRuntimeState): boolean {
    return (
      this.startingIds.has(id) ||
      rt.loopPromise !== null ||
      rt.status === 'running' ||
      rt.status === 'starting' ||
      rt.status === 'reconnecting'
    );
  }

  private findConflictingActiveRtmpSession(targetId: string, rtmpUrl: string): StreamRecord | null {
    const normalizedTarget = rtmpUrl.trim();
    for (const other of this.db.listStreams()) {
      if (other.id === targetId) continue;
      if (other.rtmp_url.trim() !== normalizedTarget) continue;
      const otherRt = this.runtimes.get(other.id);
      if (otherRt && this.isSessionActive(other.id, otherRt)) {
        return other;
      }
    }
    return null;
  }

  private buildKnownPidMap(): Map<number, KnownFfmpegSession> {
    const map = new Map<number, KnownFfmpegSession>();
    for (const record of this.db.listStreams()) {
      const rt = this.runtimes.get(record.id);
      if (rt?.pid) {
        map.set(rt.pid, { streamId: record.id, streamName: record.name });
      }
    }
    return map;
  }

  private toView(record: StreamRecord): StreamView {
    const rt = this.getOrCreateRuntime(record.id);
    const uptimeSeconds =
      rt.status === 'running' && rt.startedAtMs !== null
        ? Math.max(0, Math.floor((Date.now() - rt.startedAtMs) / 1000))
        : 0;

    return {
      id: record.id,
      name: record.name,
      rtsp_url_masked: maskRtspUrl(record.rtsp_url),
      rtmp_url_masked: maskRtmpUrl(record.rtmp_url),
      needs_stream_key: needsStreamKey(record.rtmp_url),
      enabled: record.enabled === 1,
      auto_start: record.auto_start === 1,
      status: rt.status,
      pid: rt.pid,
      uptime_seconds: uptimeSeconds,
      retry_count: rt.retryCount,
      last_error: rt.lastError ? maskCommandUrls(rt.lastError) : null,
      bitrate_kbps: rt.status === 'running' ? rt.bitrateKbps : 0,
      bytes_sent: rt.bytesSent,
      fps: rt.status === 'running' ? rt.fps : null,
      last_probe_width: record.last_probe_width ?? null,
      last_probe_height: record.last_probe_height ?? null,
      last_probe_fps: record.last_probe_fps ?? null,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }

  listStreams(): StreamView[] {
    return this.db.listStreams().map((r) => this.toView(r));
  }

  getStream(id: string): StreamView | null {
    const record = this.db.getStream(id);
    return record ? this.toView(record) : null;
  }

  getRawStream(id: string): (StreamView & { rtsp_url: string; rtmp_url: string }) | null {
    const record = this.db.getStream(id);
    if (!record) return null;
    return {
      ...this.toView(record),
      rtsp_url: record.rtsp_url,
      rtmp_url: record.rtmp_url,
    };
  }

  async probeUrl(rtspUrl: string): Promise<ProbeResult> {
    return probeRtspStream(this.config.ffprobePath, rtspUrl);
  }

  async probeStreamById(id: string): Promise<ProbeResult | null> {
    const record = this.db.getStream(id);
    if (!record) {
      return null;
    }
    const result = await probeRtspStream(this.config.ffprobePath, record.rtsp_url);
    if (result.width || result.height || result.fps) {
      this.db.updateStream(id, {
        last_probe_width: result.width,
        last_probe_height: result.height,
        last_probe_fps: result.fps,
      });
    }
    const rt = this.getOrCreateRuntime(id);
    rt.logs.push(result.ok ? 'info' : 'warn', `FFprobe: ${result.message}`);
    return result;
  }

  async createStream(
    input: CreateStreamInput & {
      skip_probe?: boolean;
      start_now?: boolean;
      probe_cache?: ProbeResult | null;
    },
  ): Promise<{ stream: StreamView; probe: ProbeResult | null }> {
    const safeName = input.name.trim();
    if (!safeName) {
      throw new Error('Stream name is required');
    }
    const safeRtsp = validateStreamUrl(input.rtsp_url, ['rtsp:', 'rtsps:']);
    const safeRtmp = validateStreamUrl(input.rtmp_url, ['rtmp:', 'rtmps:']);

    let probeResult: ProbeResult | null = input.probe_cache ?? null;
    if (!input.skip_probe && !probeResult) {
      probeResult = await probeRtspStream(this.config.ffprobePath, safeRtsp);
      if (!probeResult.ok) {
        throw new Error(probeResult.message);
      }
    }

    const record = this.db.createStream({
      name: safeName,
      rtsp_url: safeRtsp,
      rtmp_url: safeRtmp,
      enabled: input.enabled ?? true,
      auto_start: input.auto_start ?? true,
      last_probe_width: probeResult?.width ?? null,
      last_probe_height: probeResult?.height ?? null,
      last_probe_fps: probeResult?.fps ?? null,
    });

    const rt = this.getOrCreateRuntime(record.id);
    rt.logs.push(
      'info',
      probeResult
        ? `Stream created (${probeResult.message})`
        : 'Stream created (FFprobe pre-check skipped by operator)',
    );

    if (input.start_now) {
      await this.startStream(record.id, Boolean(input.skip_probe || probeResult?.ok));
    }

    const latest = this.db.getStream(record.id) ?? record;
    return { stream: this.toView(latest), probe: probeResult };
  }

  async updateStream(id: string, input: UpdateStreamInput): Promise<StreamView | null> {
    const existing = this.db.getStream(id);
    if (!existing) {
      return null;
    }

    if (input.name !== undefined && !input.name.trim()) {
      throw new Error('Stream name cannot be empty');
    }

    const nextRtsp =
      input.rtsp_url !== undefined
        ? resolveEditedRtspUrl(input.rtsp_url, existing.rtsp_url)
        : undefined;

    let nextRtmp: string | undefined;
    if (input.rtmp_url !== undefined) {
      const trimmedRtmp = input.rtmp_url.trim();
      if (!trimmedRtmp || trimmedRtmp === maskRtmpUrl(existing.rtmp_url) || trimmedRtmp.includes('****')) {
        nextRtmp = undefined;
      } else {
        nextRtmp = validateStreamUrl(trimmedRtmp, ['rtmp:', 'rtmps:']);
      }
    }

    const updated = this.db.updateStream(id, {
      name: input.name,
      rtsp_url: nextRtsp,
      rtmp_url: nextRtmp,
      enabled: input.enabled,
      auto_start: input.auto_start,
    });
    if (!updated) {
      return null;
    }

    const rt = this.getOrCreateRuntime(id);
    rt.logs.push('info', 'Stream configuration updated');
    return this.toView(updated);
  }

  async deleteStream(id: string): Promise<boolean> {
    const existing = this.db.getStream(id);
    if (!existing) {
      return false;
    }

    await this.stopStream(id, { persistStopFlag: true });
    this.runtimes.delete(id);
    return this.db.deleteStream(id);
  }

  async startStream(id: string, skipProbe = false): Promise<StreamView | null> {
    const record = this.db.getStream(id);
    if (!record) {
      return null;
    }

    if (needsStreamKey(record.rtmp_url)) {
      throw new Error('Stream Key RTMP belum diisi. Edit stream untuk memasukkan Stream Key YouTube.');
    }

    const rt = this.getOrCreateRuntime(id);
    if (this.isSessionActive(id, rt)) {
      return this.toView(record);
    }

    const conflicting = this.findConflictingActiveRtmpSession(id, record.rtmp_url);
    if (conflicting) {
      const msg = `RTMP target is already in use by active session "${conflicting.name}". Stop "${conflicting.name}" first to prevent 2 FFmpeg processes pushing to the same stream key.`;
      rt.lastError = msg;
      rt.logs.push('error', msg);
      throw new Error(msg);
    }

    this.startingIds.add(id);
    rt.lastError = null;
    rt.stopRequested = false;
    rt.status = 'starting';

    try {
      if (!skipProbe) {
        rt.logs.push('info', 'Running FFprobe H.264 verification before start...');
        const probe = await probeRtspStream(this.config.ffprobePath, record.rtsp_url);
        if (probe.width || probe.height || probe.fps) {
          this.db.updateStream(id, {
            last_probe_width: probe.width,
            last_probe_height: probe.height,
            last_probe_fps: probe.fps,
          });
        }
        if (rt.stopRequested) {
          rt.status = 'stopped';
          return this.toView(this.db.getStream(id) ?? record);
        }
        if (!probe.ok) {
          rt.status = 'error';
          rt.lastError = maskCommandUrls(probe.message);
          rt.logs.push('error', probe.message);
          throw new Error(rt.lastError);
        }
        rt.logs.push('info', probe.message);
      }

      if (rt.stopRequested) {
        rt.status = 'stopped';
        return this.toView(this.db.getStream(id) ?? record);
      }

      this.db.updateStream(id, { auto_start: true, enabled: true });

      rt.loopPromise = runSupervisorLoop(rt, this.config.ffmpegPath, () => {
        const latest = this.db.getStream(id);
        if (!latest) return null;
        return {
          name: latest.name,
          rtsp_url: latest.rtsp_url,
          rtmp_url: latest.rtmp_url,
        };
      }).finally(() => {
        rt.loopPromise = null;
      });
    } finally {
      this.startingIds.delete(id);
    }

    return this.toView(this.db.getStream(id) ?? record);
  }

  async stopStream(id: string, options: { persistStopFlag?: boolean } = {}): Promise<StreamView | null> {
    const persistStopFlag = options.persistStopFlag ?? true;
    const record = this.db.getStream(id);
    if (!record) {
      return null;
    }

    const rt = this.getOrCreateRuntime(id);
    rt.stopRequested = true;

    if (rt.wakeSleep) {
      rt.wakeSleep();
    }

    if (rt.child) {
      await terminateChildGracefully(rt.child, 5_000);
    }

    if (rt.loopPromise) {
      await rt.loopPromise;
    }

    rt.status = 'stopped';
    rt.pid = null;
    rt.startedAtMs = null;

    const updated = persistStopFlag
      ? this.db.updateStream(id, { auto_start: false }) ?? record
      : record;
    return this.toView(updated);
  }

  async stopAllManual(): Promise<{ stopped_count: number }> {
    const records = this.db.listStreams();
    let stoppedCount = 0;
    await Promise.all(
      records.map(async (rec) => {
        const rt = this.getOrCreateRuntime(rec.id);
        const wasActive = this.isSessionActive(rec.id, rt) || rec.auto_start === 1;
        await this.stopStream(rec.id, { persistStopFlag: true });
        if (wasActive) {
          stoppedCount += 1;
        }
      }),
    );
    return { stopped_count: stoppedCount };
  }

  async restartAllEnabled(staggerMs = 500): Promise<{ restarted_count: number; failed: Array<{ id: string; name: string; error: string }> }> {
    const records = this.db.listStreams();
    await Promise.all(records.map((rec) => this.stopStream(rec.id, { persistStopFlag: false })));

    const targets = records.filter((rec) => rec.enabled === 1 && !needsStreamKey(rec.rtmp_url));
    let restartedCount = 0;
    const failed: Array<{ id: string; name: string; error: string }> = [];

    for (let i = 0; i < targets.length; i += 1) {
      const rec = targets[i];
      if (i > 0 && staggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }
      try {
        await this.startStream(rec.id, true);
        restartedCount += 1;
      } catch (err) {
        failed.push({
          id: rec.id,
          name: rec.name,
          error: err instanceof Error ? err.message : 'Failed to start stream',
        });
      }
    }

    return { restarted_count: restartedCount, failed };
  }

  async autoStartOnBoot(staggerMs = 500): Promise<void> {
    const targets = this.db
      .listStreams()
      .filter((rec) => rec.enabled === 1 && rec.auto_start === 1 && !needsStreamKey(rec.rtmp_url));

    if (targets.length === 0) {
      return;
    }

    console.log(`Auto-starting ${targets.length} stream(s) with enabled=1 & auto_start=1...`);
    for (let i = 0; i < targets.length; i += 1) {
      const rec = targets[i];
      if (i > 0 && staggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }
      try {
        await this.startStream(rec.id, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Auto-start failed';
        const rt = this.getOrCreateRuntime(rec.id);
        rt.status = 'error';
        rt.lastError = msg;
        rt.logs.push('error', `Boot auto-start error: ${msg}`);
      }
    }
  }

  exportStreams(): { version: number; exported_at: string; streams: ExportedStreamItem[] } {
    const streams = this.db.listStreams().map((rec) => ({
      name: rec.name,
      rtsp_url: maskRtspUrl(rec.rtsp_url),
      rtmp_ingest: stripRtmpStreamKey(rec.rtmp_url),
      enabled: rec.enabled === 1,
      auto_start: rec.auto_start === 1,
    }));
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      streams,
    };
  }

  importStreams(items: ImportStreamItem[]): {
    imported_count: number;
    needs_stream_key_count: number;
    streams: StreamView[];
  } {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('JSON harus berisi array "streams" yang tidak kosong');
    }

    const createdViews: StreamView[] = [];
    let needsKeyCount = 0;

    for (const raw of items) {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const rtspRaw = typeof raw.rtsp_url === 'string' ? raw.rtsp_url.trim() : '';
      const rtmpProvided =
        typeof raw.rtmp_url === 'string' && raw.rtmp_url.trim()
          ? raw.rtmp_url.trim()
          : typeof raw.rtmp_ingest === 'string' && raw.rtmp_ingest.trim()
            ? raw.rtmp_ingest.trim()
            : 'rtmp://a.rtmp.youtube.com/live2/';

      if (!name || !rtspRaw) {
        throw new Error('Setiap stream wajib memiliki name dan rtsp_url');
      }

      const safeRtsp = validateStreamUrl(rtspRaw, ['rtsp:', 'rtsps:']);
      let safeRtmp = validateStreamUrl(rtmpProvided, ['rtmp:', 'rtmps:']);
      if (safeRtmp.endsWith('/')) {
        safeRtmp = `${safeRtmp}${PLACEHOLDER_KEY}`;
      } else {
        const parsed = new URL(safeRtmp);
        const segs = parsed.pathname.split('/').filter(Boolean);
        if (segs.length < 2) {
          safeRtmp = `${safeRtmp.replace(/\/+$/, '')}/${PLACEHOLDER_KEY}`;
        }
      }

      const missingKey = needsStreamKey(safeRtmp);
      if (missingKey) {
        needsKeyCount += 1;
      }

      const record = this.db.createStream({
        name,
        rtsp_url: safeRtsp,
        rtmp_url: safeRtmp,
        enabled: raw.enabled !== false,
        auto_start: missingKey ? false : raw.auto_start !== false,
      });

      const rt = this.getOrCreateRuntime(record.id);
      rt.logs.push(
        'info',
        missingKey
          ? 'Imported from JSON (perlu input ulang Stream Key RTMP dan password RTSP jika bertanda ****)'
          : 'Imported from JSON',
      );
      createdViews.push(this.toView(record));
    }

    return {
      imported_count: createdViews.length,
      needs_stream_key_count: needsKeyCount,
      streams: createdViews,
    };
  }

  getLogs(id: string): StreamLogEntry[] | null {
    const record = this.db.getStream(id);
    if (!record) {
      return null;
    }
    return this.getOrCreateRuntime(id).logs.list();
  }

  getBandwidthSnapshot(): BandwidthSnapshot {
    return this.bandwidthMonitor.getSnapshot();
  }

  async listOsFfmpegSessions(): Promise<{
    sessions: FfmpegOsSession[];
    total_os_ffmpeg: number;
    orphan_count: number;
  }> {
    const sessions = await inspectOsFfmpegSessions(this.buildKnownPidMap());
    const orphanCount = sessions.filter((s) => !s.managed).length;
    return {
      sessions,
      total_os_ffmpeg: sessions.length,
      orphan_count: orphanCount,
    };
  }

  async cleanupOrphanFfmpegSessions(): Promise<{
    killed_pids: number[];
    sessions: FfmpegOsSession[];
    total_os_ffmpeg: number;
    orphan_count: number;
  }> {
    const { killedPids, sessions } = await cleanupOrphanFfmpegSessions(this.buildKnownPidMap());
    return {
      killed_pids: killedPids,
      sessions,
      total_os_ffmpeg: sessions.length,
      orphan_count: sessions.filter((s) => !s.managed).length,
    };
  }

  async stopAll(): Promise<void> {
    this.bandwidthMonitor.stop();
    const ids = Array.from(this.runtimes.keys());
    await Promise.all(ids.map((id) => this.stopStream(id, { persistStopFlag: false })));
  }
}
