export function maskRtspUrl(rawUrl: string): string {
  return rawUrl.replace(/(rtsps?:\/\/)([^:/@\s]+):([^\s/@]+)@/gi, '$1$2:****@');
}

export function maskRtmpStreamKey(key: string): string {
  if (!key) return '****';
  if (key.length <= 4) {
    return '****';
  }
  const tail = key.slice(-4);
  const head = key.slice(0, -4);
  if (head.includes('-')) {
    return `${head.replace(/[^-]/g, '*')}${tail}`;
  }
  return `****-${tail}`;
}

export function maskRtmpUrl(rawUrl: string): string {
  return rawUrl.replace(
    /(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)([^\s]+)/gi,
    (_full, prefix: string, key: string) => `${prefix}${maskRtmpStreamKey(key)}`,
  );
}

export function maskCommandUrls(text: string): string {
  return maskRtmpUrl(maskRtspUrl(text));
}
