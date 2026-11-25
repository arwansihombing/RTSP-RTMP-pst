import type { BandwidthSnapshot } from '../types';
import { formatBitrate, formatBytes } from '../utils/streamFormat';

interface BandwidthPanelProps {
  bandwidth: BandwidthSnapshot | null;
}

const CHART_W = 1000;
const CHART_H = 120;
const PAD_Y = 8;

export function BandwidthPanel({ bandwidth }: BandwidthPanelProps) {
  const history = bandwidth?.history ?? [];

  const maxObserved = history.reduce((max, s) => {
    return Math.max(max, s.stream_egress_kbps, s.host_rx_kbps, s.host_tx_kbps);
  }, 0);

  // Nice rounded ceiling >= 100 kbps so chart scale stays legible even at idle
  const yMax = maxObserved <= 10 ? 100 : Math.ceil((maxObserved * 1.2) / 50) * 50;
  const plotH = CHART_H - PAD_Y * 2;

  const points = history.slice(-60);
  const count = points.length;

  function toCoords(selector: (s: (typeof points)[number]) => number): string {
    if (count === 0) return '';
    if (count === 1) {
      const y = PAD_Y + plotH - (Math.min(yMax, selector(points[0])) / yMax) * plotH;
      return `0,${y.toFixed(1)} ${CHART_W},${y.toFixed(1)}`;
    }
    return points
      .map((pt, idx) => {
        const x = (idx / (count - 1)) * CHART_W;
        const val = Math.max(0, Math.min(yMax, selector(pt)));
        const y = PAD_Y + plotH - (val / yMax) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  function toAreaPath(selector: (s: (typeof points)[number]) => number): string {
    const line = toCoords(selector);
    if (!line) return '';
    const baseY = (PAD_Y + plotH).toFixed(1);
    return `M 0,${baseY} L ${line.replace(/ /g, ' L ')} L ${CHART_W},${baseY} Z`;
  }

  const streamCoords = toCoords((s) => s.stream_egress_kbps);
  const streamArea = toAreaPath((s) => s.stream_egress_kbps);
  const hostTxCoords = toCoords((s) => s.host_tx_kbps);
  const hostRxCoords = toCoords((s) => s.host_rx_kbps);

  const formatAxisKbps = (valKbps: number) =>
    valKbps >= 1000 ? `${(valKbps / 1000).toFixed(1)}M` : `${Math.round(valKbps)}k`;

  const gridLevels = [1, 0.5, 0];

  return (
    <section
      aria-label="Live bandwidth monitoring"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 [&>*]:border-slate-200 [&>*:nth-child(odd)]:border-r [&>*:nth-child(-n+2)]:border-b lg:[&>*]:border-b-0 lg:[&>*:not(:last-child)]:border-r">
        <div className="p-4 sm:px-6">
          <div className="text-xs font-medium text-slate-500">Live Stream Egress</div>
          <div className="mt-1 text-xl font-semibold font-mono text-emerald-700 tabular-nums">
            {formatBitrate(bandwidth?.stream_egress_kbps ?? 0)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
            {bandwidth?.active_streams ?? 0} active FFmpeg stream
            {(bandwidth?.active_streams ?? 0) === 1 ? '' : 's'}
          </div>
        </div>

        <div className="p-4 sm:px-6">
          <div className="text-xs font-medium text-slate-500">Host NIC RX (Ingress)</div>
          <div className="mt-1 text-xl font-semibold font-mono text-slate-900 tabular-nums">
            {formatBitrate(bandwidth?.host_rx_kbps ?? 0)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
            Session: {formatBytes(bandwidth?.host_rx_bytes_session ?? 0)}
          </div>
        </div>

        <div className="p-4 sm:px-6">
          <div className="text-xs font-medium text-slate-500">Host NIC TX (Egress)</div>
          <div className="mt-1 text-xl font-semibold font-mono text-sky-700 tabular-nums">
            {formatBitrate(bandwidth?.host_tx_kbps ?? 0)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
            Session: {formatBytes(bandwidth?.host_tx_bytes_session ?? 0)}
          </div>
        </div>

        <div className="p-4 sm:px-6">
          <div className="text-xs font-medium text-slate-500">FFmpeg Data Sent</div>
          <div className="mt-1 text-xl font-semibold font-mono text-slate-900 tabular-nums">
            {formatBytes(bandwidth?.total_bytes_sent ?? 0)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
            {bandwidth?.interface_count ?? 0} network interface
            {(bandwidth?.interface_count ?? 0) === 1 ? '' : 's'} monitored
          </div>
        </div>
      </div>

      <div className="border-t border-slate-200 px-4 sm:px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-xs font-semibold text-slate-700">
            Bandwidth Throughput (Last 60s)
          </h2>
          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-emerald-600 inline-block" aria-hidden="true" />
              <span>Stream Egress</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-sky-600 inline-block" aria-hidden="true" />
              <span>Host TX</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-slate-400 inline-block" aria-hidden="true" />
              <span>Host RX</span>
            </span>
          </div>
        </div>

        <div className="flex items-stretch gap-3">
          <div className="w-11 shrink-0 flex flex-col justify-between py-0.5 text-right font-mono text-[11px] leading-none text-slate-500 tabular-nums">
            <span>{formatAxisKbps(yMax)}</span>
            <span>{formatAxisKbps(yMax * 0.5)}</span>
            <span>0k</span>
          </div>

          <div className="flex-1 min-w-0">
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              className="w-full h-28 block"
              role="img"
              aria-label="Live bandwidth throughput chart over the last 60 seconds"
            >
              {gridLevels.map((ratio) => {
                const y = PAD_Y + plotH * (1 - ratio);
                return (
                  <line
                    key={ratio}
                    x1={0}
                    y1={y}
                    x2={CHART_W}
                    y2={y}
                    stroke="#e2e8f0"
                    strokeDasharray={ratio === 0 ? undefined : '4 4'}
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {streamArea && <path d={streamArea} fill="rgba(22, 163, 74, 0.10)" />}

              {hostRxCoords && (
                <polyline
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  points={hostRxCoords}
                />
              )}

              {hostTxCoords && (
                <polyline
                  fill="none"
                  stroke="#0284c7"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  points={hostTxCoords}
                />
              )}

              {streamCoords && (
                <polyline
                  fill="none"
                  stroke="#16a34a"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  points={streamCoords}
                />
              )}
            </svg>

            <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-slate-500 tabular-nums">
              <span>-60s</span>
              <span>-30s</span>
              <span>now</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
