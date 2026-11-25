export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '00:00:00';
  }
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
}

export function formatBitrate(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) {
    return '0 kbps';
  }
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(2)} Mbps`;
  }
  return `${kbps.toFixed(1)} kbps`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  const decimals = idx === 0 ? 0 : idx === 1 ? 1 : 2;
  return `${val.toFixed(decimals)} ${units[idx]}`;
}

export function truncateMiddle(value: string, maxLength = 40): string {
  if (value.length <= maxLength) {
    return value;
  }
  const keepStart = Math.ceil((maxLength - 3) * 0.6);
  const keepEnd = maxLength - 3 - keepStart;
  return `${value.slice(0, keepStart)}...${value.slice(value.length - keepEnd)}`;
}

export function maskRtmpUrl(url: string): string {
  const idx = url.lastIndexOf('/');
  if (idx === -1 || idx === url.length - 1) {
    return truncateMiddle(url, 38);
  }
  const prefix = url.slice(0, idx + 1);
  const key = url.slice(idx + 1);
  const maskedKey = key.length <= 4 ? '••••' : `${key.slice(0, 4)}••••`;
  return truncateMiddle(`${prefix}${maskedKey}`, 38);
}

export function validateStreamForm(input: {
  name: string;
  rtsp_url: string;
  rtmp_url: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) {
    errors.name = 'Stream name is required.';
  }

  const rtsp = input.rtsp_url.trim();
  if (!rtsp) {
    errors.rtsp_url = 'RTSP URL is required.';
  } else if (!/^rtsps?:\/\//i.test(rtsp)) {
    errors.rtsp_url = 'RTSP URL must start with rtsp:// (or rtsps://).';
  }

  const rtmp = input.rtmp_url.trim();
  if (!rtmp) {
    errors.rtmp_url = 'RTMP URL is required.';
  } else if (!/^rtmps?:\/\//i.test(rtmp)) {
    errors.rtmp_url = 'RTMP URL must start with rtmp:// (or rtmps://).';
  }

  return errors;
}
