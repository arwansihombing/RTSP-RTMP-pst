export function SpecView() {
  const ffmpegCommand = `ffmpeg -hide_banner -loglevel warning \\
  -rtsp_transport tcp \\
  -fflags +genpts \\
  -i "{RTSP_URL}" \\
  -map 0:v:0 \\
  -c:v copy \\
  -an \\
  -f flv \\
  -flvflags no_duration_filesize \\
  "{RTMP_URL}"`;

  const flagRows = [
    { flag: '-rtsp_transport tcp', role: 'Enforces reliable TCP interleaved RTSP transport over unstable DVR LAN links' },
    { flag: '-fflags +genpts', role: 'Regenerates presentation timestamps when CCTV DVR streams emit non-monotonous DTS' },
    { flag: '-map 0:v:0', role: 'Selects exclusively the first video track so missing audio streams never crash FFmpeg' },
    { flag: '-c:v copy', role: 'Zero-transcoding H.264 bitstream passthrough (<5% CPU per camera process)' },
    { flag: '-an', role: 'Explicitly disables audio muxing for audio-less CCTV DVR feeds' },
    { flag: '-f flv -flvflags no_duration_filesize', role: 'Live RTMP FLV muxing compatible with YouTube Live ingest endpoints' },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">FFmpeg Passthrough Specification</h2>
          <p className="text-sm text-slate-600 mt-1">
            Every stream spawns an isolated FFmpeg child process with H.264 bitstream copy and no audio mapping.
          </p>
        </div>

        <pre className="bg-slate-950 text-slate-100 rounded-md p-4 text-xs font-mono overflow-x-auto leading-relaxed">
          {ffmpegCommand}
        </pre>

        <div className="border-t border-slate-200 pt-4">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Flag Breakdown</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                  <th className="py-2 pr-4">Flag</th>
                  <th className="py-2">Purpose</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {flagRows.map((row) => (
                  <tr key={row.flag}>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-900 whitespace-nowrap">{row.flag}</td>
                    <td className="py-2.5 text-slate-600">{row.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Supervisor Auto-Reconnect Policy</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 text-sm">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md">
            <div className="text-xs text-slate-500">Exponential Backoff</div>
            <div className="mt-1 font-mono font-medium text-slate-900 tabular-nums">3s · 5s · 10s · 30s · 60s</div>
            <p className="mt-1.5 text-xs text-slate-600">
              Resets to 3s automatically whenever a stream remains running cleanly for over 60 seconds.
            </p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md">
            <div className="text-xs text-slate-500">Retry Cap & Error State</div>
            <div className="mt-1 font-mono font-medium text-slate-900 tabular-nums">Max 10 attempts</div>
            <p className="mt-1.5 text-xs text-slate-600">
              After 10 consecutive failures, transitions to Error status until manually restarted.
            </p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md">
            <div className="text-xs text-slate-500">Graceful Process Cleanup</div>
            <div className="mt-1 font-mono font-medium text-slate-900 tabular-nums">SIGTERM → 5s → SIGKILL</div>
            <p className="mt-1.5 text-xs text-slate-600">
              Every child process is awaited on exit to guarantee zero zombie FFmpeg processes.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
