import type { AppConfig } from '../config';
import type { CreateStreamInput, StreamDatabase, UpdateStreamInput } from '../db';
import { BandwidthMonitor } from './bandwidth';
import { validateStreamUrl } from './ffmpeg';
import { probeRtspStream } from './probe';
import {
  createInitialRuntime,
  runSupervisorLoop,
  terminateChildGracefully,
  type StreamRuntimeState,
} from './supervisor';
import type { BandwidthSnapshot, ProbeResult, StreamLogEntry, StreamRecord, StreamView } from './types';

export class StreamManager {
  private readonly runtimes = new Map<string, StreamRuntimeState>();
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

  private toView(record: StreamRecord): StreamView {
    const rt = this.getOrCreateRuntime(record.id);
    const uptimeSeconds =
      rt.status === 'running' && rt.startedAtMs !== null
        ? Math.max(0, Math.floor((Date.now() - rt.startedAtMs) / 1000))
        : 0;

    return {
      id: record.id,
      name: record.name,
      rtsp_url: record.rtsp_url,
      rtmp_url: record.rtmp_url,
      enabled: record.enabled === 1,
      status: rt.status,
      pid: rt.pid,
      uptime_seconds: uptimeSeconds,
      retry_count: rt.retryCount,
      last_error: rt.lastError,
      bitrate_kbps: rt.status === 'running' ? rt.bitrateKbps : 0,
      bytes_sent: rt.bytesSent,
      fps: rt.status === 'running' ? rt.fps : null,
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

  async probeUrl(rtspUrl: string): Promise<ProbeResult> {
    return probeRtspStream(this.config.ffprobePath, rtspUrl);
  }

  async probeStreamById(id: string): Promise<ProbeResult | null> {
    const record = this.db.getStream(id);
    if (!record) {
      return null;
    }
    const result = await probeRtspStream(this.config.ffprobePath, record.rtsp_url);
    const rt = this.getOrCreateRuntime(id);
    rt.logs.push(result.ok ? 'info' : 'warn', `FFprobe: ${result.message}`);
    return result;
  }

  async createStream(
    input: CreateStreamInput & { skip_probe?: boolean; auto_start?: boolean },
  ): Promise<{ stream: StreamView; probe: ProbeResult | null }> {
    const safeName = input.name.trim();
    if (!safeName) {
      throw new Error('Stream name is required');
    }
    const safeRtsp = validateStreamUrl(input.rtsp_url, ['rtsp:', 'rtsps:']);
    const safeRtmp = validateStreamUrl(input.rtmp_url, ['rtmp:', 'rtmps:']);

    let probeResult: ProbeResult | null = null;
    if (!input.skip_probe) {
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
    });

    const rt = this.getOrCreateRuntime(record.id);
    rt.logs.push(
      'info',
      probeResult
        ? `Stream created (${probeResult.message})`
        : 'Stream created (FFprobe pre-check skipped by operator)',
    );

    if (input.auto_start) {
      await this.startStream(record.id, Boolean(input.skip_probe));
    }

    return { stream: this.toView(record), probe: probeResult };
  }

  async updateStream(id: string, input: UpdateStreamInput): Promise<StreamView | null> {
    const existing = this.db.getStream(id);
    if (!existing) {
      return null;
    }

    if (input.name !== undefined && !input.name.trim()) {
      throw new Error('Stream name cannot be empty');
    }
    if (input.rtsp_url !== undefined) {
      validateStreamUrl(input.rtsp_url, ['rtsp:', 'rtsps:']);
    }
    if (input.rtmp_url !== undefined) {
      validateStreamUrl(input.rtmp_url, ['rtmp:', 'rtmps:']);
    }

    const updated = this.db.updateStream(id, input);
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

    await this.stopStream(id);
    this.runtimes.delete(id);
    return this.db.deleteStream(id);
  }

  async startStream(id: string, skipProbe = false): Promise<StreamView | null> {
    const record = this.db.getStream(id);
    if (!record) {
      return null;
    }

    const rt = this.getOrCreateRuntime(id);
    if (rt.loopPromise && (rt.status === 'running' || rt.status === 'starting' || rt.status === 'reconnecting')) {
      return this.toView(record);
    }

    rt.lastError = null;
    rt.stopRequested = false;

    if (!skipProbe) {
      rt.status = 'starting';
      rt.logs.push('info', 'Running FFprobe H.264 verification before start...');
      const probe = await probeRtspStream(this.config.ffprobePath, record.rtsp_url);
      if (!probe.ok) {
        rt.status = 'error';
        rt.lastError = probe.message;
        rt.logs.push('error', probe.message);
        throw new Error(probe.message);
      }
      rt.logs.push('info', probe.message);
    }

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

    return this.toView(record);
  }

  async stopStream(id: string): Promise<StreamView | null> {
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
    return this.toView(record);
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

  async stopAll(): Promise<void> {
    this.bandwidthMonitor.stop();
    const ids = Array.from(this.runtimes.keys());
    await Promise.all(ids.map((id) => this.stopStream(id)));
  }
}
