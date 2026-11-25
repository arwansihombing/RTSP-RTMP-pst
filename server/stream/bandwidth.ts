import fs from 'node:fs/promises';
import type { BandwidthSample, BandwidthSnapshot } from './types';

export interface HostNetTotals {
  rxBytes: number;
  txBytes: number;
  interfaceCount: number;
}

export function parseProcNetDev(content: string): HostNetTotals {
  const lines = content.split('\n');
  let rxBytes = 0;
  let txBytes = 0;
  let interfaceCount = 0;

  for (let i = 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const iface = line.slice(0, colonIdx).trim();
    if (!iface || iface === 'lo') continue;

    const fields = line
      .slice(colonIdx + 1)
      .trim()
      .split(/\s+/);
    if (fields.length < 9) continue;

    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (Number.isFinite(rx) && Number.isFinite(tx)) {
      rxBytes += rx;
      txBytes += tx;
      interfaceCount += 1;
    }
  }

  return { rxBytes, txBytes, interfaceCount };
}

export const MAX_BANDWIDTH_HISTORY = 60;

export class BandwidthMonitor {
  private readonly history: BandwidthSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private baselineHost: HostNetTotals | null = null;
  private prevHost: { totals: HostNetTotals; tsMs: number } | null = null;
  private latestSnapshot: BandwidthSnapshot = {
    stream_egress_kbps: 0,
    host_rx_kbps: 0,
    host_tx_kbps: 0,
    total_bytes_sent: 0,
    host_rx_bytes_session: 0,
    host_tx_bytes_session: 0,
    active_streams: 0,
    interface_count: 0,
    history: [],
  };

  constructor(
    private readonly getStreamMetrics: () => {
      egressKbps: number;
      totalBytesSent: number;
      activeStreams: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sampleOnce();
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sampleOnce(): Promise<BandwidthSnapshot> {
    const nowMs = Date.now();
    let hostTotals: HostNetTotals = { rxBytes: 0, txBytes: 0, interfaceCount: 0 };

    try {
      const content = await fs.readFile('/proc/net/dev', 'utf8');
      hostTotals = parseProcNetDev(content);
    } catch {
      // Non-Linux or restricted procfs fallback: host interface counters stay 0
    }

    if (!this.baselineHost && hostTotals.interfaceCount > 0) {
      this.baselineHost = hostTotals;
    }

    let hostRxKbps = 0;
    let hostTxKbps = 0;
    if (this.prevHost && hostTotals.interfaceCount > 0) {
      const elapsedSec = Math.max(0.2, (nowMs - this.prevHost.tsMs) / 1000);
      const rxDelta = Math.max(0, hostTotals.rxBytes - this.prevHost.totals.rxBytes);
      const txDelta = Math.max(0, hostTotals.txBytes - this.prevHost.totals.txBytes);
      hostRxKbps = Math.round(((rxDelta * 8) / 1000 / elapsedSec) * 10) / 10;
      hostTxKbps = Math.round(((txDelta * 8) / 1000 / elapsedSec) * 10) / 10;
    }
    if (hostTotals.interfaceCount > 0) {
      this.prevHost = { totals: hostTotals, tsMs: nowMs };
    }

    const streamStats = this.getStreamMetrics();
    const streamEgressKbps = Math.round(streamStats.egressKbps * 10) / 10;

    const sample: BandwidthSample = {
      timestamp: nowMs,
      stream_egress_kbps: streamEgressKbps,
      host_rx_kbps: hostRxKbps,
      host_tx_kbps: hostTxKbps,
    };

    this.history.push(sample);
    if (this.history.length > MAX_BANDWIDTH_HISTORY) {
      this.history.splice(0, this.history.length - MAX_BANDWIDTH_HISTORY);
    }

    this.latestSnapshot = {
      stream_egress_kbps: streamEgressKbps,
      host_rx_kbps: hostRxKbps,
      host_tx_kbps: hostTxKbps,
      total_bytes_sent: streamStats.totalBytesSent,
      host_rx_bytes_session: this.baselineHost
        ? Math.max(0, hostTotals.rxBytes - this.baselineHost.rxBytes)
        : 0,
      host_tx_bytes_session: this.baselineHost
        ? Math.max(0, hostTotals.txBytes - this.baselineHost.txBytes)
        : 0,
      active_streams: streamStats.activeStreams,
      interface_count: hostTotals.interfaceCount,
      history: [...this.history],
    };

    return this.latestSnapshot;
  }

  getSnapshot(): BandwidthSnapshot {
    const streamStats = this.getStreamMetrics();
    return {
      ...this.latestSnapshot,
      stream_egress_kbps: Math.round(streamStats.egressKbps * 10) / 10,
      total_bytes_sent: streamStats.totalBytesSent,
      active_streams: streamStats.activeStreams,
      history: [...this.history],
    };
  }
}
