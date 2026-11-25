const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');

const tbody = document.getElementById('streams-tbody');
const toastEl = document.getElementById('toast');
const streamModal = document.getElementById('stream-modal');
const streamForm = document.getElementById('stream-form');
const modalTitle = document.getElementById('modal-title');
const fieldId = document.getElementById('field-id');
const fieldName = document.getElementById('field-name');
const fieldRtsp = document.getElementById('field-rtsp');
const fieldRtmp = document.getElementById('field-rtmp');
const formError = document.getElementById('form-error');
const logsModal = document.getElementById('logs-modal');
const logsTitle = document.getElementById('logs-title');
const logsPre = document.getElementById('logs-pre');

const bwEgress = document.getElementById('bw-egress');
const bwActive = document.getElementById('bw-active');
const bwRx = document.getElementById('bw-rx');
const bwRxBytes = document.getElementById('bw-rx-bytes');
const bwTx = document.getElementById('bw-tx');
const bwTxBytes = document.getElementById('bw-tx-bytes');
const bwSent = document.getElementById('bw-sent');
const bwIfaces = document.getElementById('bw-ifaces');
const bwYmax = document.getElementById('bw-ymax');
const bwYmid = document.getElementById('bw-ymid');
const bwChart = document.getElementById('bw-chart');

let activeLogsId = null;
let pollTimer = null;
let bwTimer = null;

function showLogin() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (bwTimer) {
    clearInterval(bwTimer);
    bwTimer = null;
  }
  dashboardView.classList.add('hidden');
  loginView.classList.remove('hidden');
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  loadStreams();
  loadBandwidth();
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (!document.hidden) {
        loadStreams();
        if (activeLogsId) refreshLogs();
      }
    }, 2000);
  }
  if (!bwTimer) {
    bwTimer = setInterval(() => {
      if (!document.hidden) {
        loadBandwidth();
      }
    }, 1000);
  }
}

async function checkAuth() {
  try {
    const res = await fetch('/auth/session');
    const data = await res.json();
    if (data && data.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showToast(kind, text) {
  toastEl.textContent = text;
  toastEl.className =
    kind === 'error'
      ? 'px-4 py-3 text-sm rounded-md border bg-red-50 border-red-200 text-red-900'
      : 'px-4 py-3 text-sm rounded-md border bg-emerald-50 border-emerald-200 text-emerald-900';
  toastEl.classList.remove('hidden');
  setTimeout(() => toastEl.classList.add('hidden'), 4000);
}

function truncate(str, max = 38) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, 22) + '...' + str.slice(-13);
}

function formatUptime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const r = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${r}`;
}

function statusMeta(status) {
  switch (status) {
    case 'running':
      return { dot: 'bg-emerald-600', text: 'text-emerald-700', label: 'Running' };
    case 'reconnecting':
      return { dot: 'bg-amber-600', text: 'text-amber-700', label: 'Reconnecting' };
    case 'starting':
      return { dot: 'bg-sky-600', text: 'text-sky-700', label: 'Starting' };
    case 'error':
      return { dot: 'bg-red-600', text: 'text-red-700', label: 'Error' };
    default:
      return { dot: 'bg-slate-400', text: 'text-slate-600', label: 'Stopped' };
  }
}

function formatBitrate(kbps) {
  const n = Math.max(0, Number(kbps) || 0);
  if (n >= 1000) return `${(n / 1000).toFixed(2)} Mbps`;
  return `${Math.round(n)} kbps`;
}

function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = b / 1024;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[idx]}`;
}

function formatAxisKbps(valKbps) {
  return valKbps >= 1000 ? `${(valKbps / 1000).toFixed(1)}M` : `${Math.round(valKbps)}k`;
}

function renderBandwidthChart(history) {
  if (!bwChart) return;
  const W = 1000, H = 120, PY = 8;
  const ph = H - PY * 2;
  const pts = (history || []).slice(-60);
  let maxVal = 0;
  for (const s of pts) {
    maxVal = Math.max(maxVal, s.stream_egress_kbps || 0, s.host_rx_kbps || 0, s.host_tx_kbps || 0);
  }
  const yMax = maxVal <= 10 ? 100 : Math.ceil((maxVal * 1.2) / 50) * 50;
  if (bwYmax) bwYmax.textContent = formatAxisKbps(yMax);
  if (bwYmid) bwYmid.textContent = formatAxisKbps(yMax * 0.5);

  const coords = (fn) => {
    if (!pts.length) return '';
    if (pts.length === 1) {
      const y = PY + ph - (Math.min(yMax, fn(pts[0])) / yMax) * ph;
      return `0,${y.toFixed(1)} ${W},${y.toFixed(1)}`;
    }
    return pts.map((p, i) => {
      const x = (i / (pts.length - 1)) * W;
      const y = PY + ph - (Math.max(0, Math.min(yMax, fn(p))) / yMax) * ph;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };

  let svg = '';
  for (const ratio of [1, 0.5, 0]) {
    const y = PY + ph * (1 - ratio);
    svg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#e2e8f0" ${ratio === 0 ? '' : 'stroke-dasharray="4 4"'} stroke-width="1" vector-effect="non-scaling-stroke" />`;
  }
  const rxPts = coords((s) => s.host_rx_kbps || 0);
  const txPts = coords((s) => s.host_tx_kbps || 0);
  const stPts = coords((s) => s.stream_egress_kbps || 0);
  if (rxPts) svg += `<polyline fill="none" stroke="#94a3b8" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${rxPts}" />`;
  if (txPts) svg += `<polyline fill="none" stroke="#0284c7" stroke-width="1.75" vector-effect="non-scaling-stroke" points="${txPts}" />`;
  if (stPts) svg += `<polyline fill="none" stroke="#16a34a" stroke-width="2" vector-effect="non-scaling-stroke" points="${stPts}" />`;
  bwChart.innerHTML = svg;
}

async function loadBandwidth() {
  try {
    const res = await fetch('/api/bandwidth');
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) return;
    const d = await res.json();
    bwEgress.textContent = formatBitrate(d.stream_egress_kbps || 0);
    const active = d.active_streams || 0;
    bwActive.textContent = `${active} active FFmpeg stream${active === 1 ? '' : 's'}`;
    bwRx.textContent = formatBitrate(d.host_rx_kbps || 0);
    bwRxBytes.textContent = `Session: ${formatBytes(d.host_rx_bytes_session || 0)}`;
    bwTx.textContent = formatBitrate(d.host_tx_kbps || 0);
    bwTxBytes.textContent = `Session: ${formatBytes(d.host_tx_bytes_session || 0)}`;
    bwSent.textContent = formatBytes(d.total_bytes_sent || 0);
    const ifaces = d.interface_count || 0;
    bwIfaces.textContent = `${ifaces} network interface${ifaces === 1 ? '' : 's'} monitored`;
    renderBandwidthChart(d.history || []);
  } catch (err) {
    console.error('Failed to poll bandwidth:', err);
  }
}

async function loadStreams() {
  try {
    const res = await fetch('/api/streams');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    renderStreams(data.streams || []);
  } catch (err) {
    console.error('Failed to poll streams:', err);
  }
}

function makeActionButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.className = cls;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderStreams(streams) {
  tbody.innerHTML = '';
  if (!streams.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'py-8 px-4 text-center text-slate-500';
    td.textContent = 'No streams configured yet. Click + Add Stream to begin.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const s of streams) {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50';

    const tdName = document.createElement('td');
    tdName.className = 'py-3 px-4 font-medium';
    tdName.textContent = s.name;

    const tdRtsp = document.createElement('td');
    tdRtsp.className = 'py-3 px-4 font-mono text-xs text-slate-600';
    tdRtsp.title = s.rtsp_url;
    tdRtsp.textContent = truncate(s.rtsp_url);

    const tdRtmp = document.createElement('td');
    tdRtmp.className = 'py-3 px-4 font-mono text-xs text-slate-600';
    tdRtmp.title = s.rtmp_url;
    tdRtmp.textContent = truncate(s.rtmp_url);

    const tdStatus = document.createElement('td');
    tdStatus.className = 'py-3 px-4';
    const meta = statusMeta(s.status);
    const wrap = document.createElement('span');
    wrap.className = `inline-flex items-center gap-2 text-xs font-medium ${meta.text}`;
    const dot = document.createElement('span');
    dot.className = `h-2 w-2 rounded-full ${meta.dot}`;
    const lbl = document.createElement('span');
    lbl.textContent = meta.label;
    wrap.append(dot, lbl);
    tdStatus.appendChild(wrap);

    const tdBw = document.createElement('td');
    tdBw.className = 'py-3 px-4 text-right font-mono text-xs tabular-nums';
    const bwRate = document.createElement('div');
    bwRate.className = (s.bitrate_kbps || 0) > 0 ? 'text-emerald-700 font-medium' : 'text-slate-600';
    bwRate.textContent = formatBitrate(s.bitrate_kbps || 0);
    const bwTotal = document.createElement('div');
    bwTotal.className = 'text-[11px] text-slate-500';
    bwTotal.textContent = formatBytes(s.bytes_sent || 0);
    tdBw.append(bwRate, bwTotal);

    const tdUptime = document.createElement('td');
    tdUptime.className = 'py-3 px-4 text-right font-mono text-xs tabular-nums';
    tdUptime.textContent = formatUptime(s.uptime_seconds);

    const tdActions = document.createElement('td');
    tdActions.className = 'py-3 px-4 text-right space-x-1.5 whitespace-nowrap';

    const isActive = s.status === 'running' || s.status === 'starting' || s.status === 'reconnecting';
    if (isActive) {
      tdActions.appendChild(
        makeActionButton('Stop', 'px-2.5 py-1 text-xs border border-red-200 bg-red-50 text-red-700 rounded', () =>
          postAction(`/api/streams/${s.id}/stop`, `Stopped ${s.name}`)
        )
      );
    } else {
      tdActions.appendChild(
        makeActionButton('Start', 'px-2.5 py-1 text-xs border border-emerald-200 bg-emerald-50 text-emerald-700 rounded', () =>
          postAction(`/api/streams/${s.id}/start`, `Started ${s.name}`)
        )
      );
    }

    tdActions.appendChild(
      makeActionButton('Edit', 'px-2.5 py-1 text-xs border border-slate-300 rounded', () => openModal(s))
    );
    tdActions.appendChild(
      makeActionButton('Logs', 'px-2.5 py-1 text-xs border border-slate-300 rounded', () => openLogs(s))
    );
    tdActions.appendChild(
      makeActionButton('Delete', 'px-2.5 py-1 text-xs border border-slate-300 text-red-700 rounded', async () => {
        if (!window.confirm(`Delete stream "${s.name}"?`)) return;
        const res = await fetch(`/api/streams/${s.id}`, { method: 'DELETE' });
        if (res.status === 401) {
          showLogin();
          return;
        }
        if (res.ok) {
          showToast('success', `Deleted ${s.name}`);
          loadStreams();
        }
      })
    );

    tr.append(tdName, tdRtsp, tdRtmp, tdStatus, tdBw, tdUptime, tdActions);
    tbody.appendChild(tr);
  }
}

async function postAction(url, okMsg) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (res.status === 401) {
    showLogin();
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast('error', data.error || 'Action failed');
  } else {
    showToast('success', okMsg);
  }
  loadStreams();
}

function openModal(stream = null) {
  formError.classList.add('hidden');
  if (stream) {
    modalTitle.textContent = 'Edit Stream';
    fieldId.value = stream.id;
    fieldName.value = stream.name;
    fieldRtsp.value = stream.rtsp_url;
    fieldRtmp.value = stream.rtmp_url;
  } else {
    modalTitle.textContent = 'Add Stream';
    fieldId.value = '';
    fieldName.value = '';
    fieldRtsp.value = '';
    fieldRtmp.value = '';
  }
  streamModal.classList.remove('hidden');
}

async function openLogs(stream) {
  activeLogsId = stream.id;
  logsTitle.textContent = `Logs — ${stream.name}`;
  logsModal.classList.remove('hidden');
  await refreshLogs();
}

async function refreshLogs() {
  if (!activeLogsId) return;
  const res = await fetch(`/api/streams/${activeLogsId}/logs`);
  if (res.status === 401) {
    showLogin();
    return;
  }
  if (!res.ok) return;
  const data = await res.json();
  const lines = (data.logs || []).map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`);
  logsPre.textContent = lines.length ? lines.join('\n') : 'No log output yet.';
  logsPre.scrollTop = logsPre.scrollHeight;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: loginUsername.value.trim(),
      password: loginPassword.value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    loginError.textContent = data.error || 'Login gagal';
    loginError.classList.remove('hidden');
    return;
  }
  loginPassword.value = '';
  showDashboard();
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

document.getElementById('btn-add-stream').addEventListener('click', () => openModal(null));
document.getElementById('btn-close-modal').addEventListener('click', () => streamModal.classList.add('hidden'));
document.getElementById('btn-cancel-modal').addEventListener('click', () => streamModal.classList.add('hidden'));
document.getElementById('btn-close-logs').addEventListener('click', () => {
  activeLogsId = null;
  logsModal.classList.add('hidden');
});

streamForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.classList.add('hidden');

  const name = fieldName.value.trim();
  const rtsp = fieldRtsp.value.trim();
  const rtmp = fieldRtmp.value.trim();

  if (!rtsp.startsWith('rtsp://') && !rtsp.startsWith('rtsps://')) {
    formError.textContent = 'RTSP URL must start with rtsp://';
    formError.classList.remove('hidden');
    return;
  }
  if (!rtmp.startsWith('rtmp://') && !rtmp.startsWith('rtmps://')) {
    formError.textContent = 'RTMP URL must start with rtmp://';
    formError.classList.remove('hidden');
    return;
  }

  const id = fieldId.value;
  const res = await fetch(id ? `/api/streams/${id}` : '/api/streams', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, rtsp_url: rtsp, rtmp_url: rtmp }),
  });
  if (res.status === 401) {
    showLogin();
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    formError.textContent = data.error || 'Failed to save stream';
    formError.classList.remove('hidden');
    return;
  }

  streamModal.classList.add('hidden');
  showToast('success', id ? `Updated ${name}` : `Added ${name}`);
  loadStreams();
});

checkAuth();
