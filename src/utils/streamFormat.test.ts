import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBitrate, formatBytes, formatUptime, maskRtmpUrl, validateStreamForm } from './streamFormat';

test('formatUptime formats HH:MM:SS cleanly', () => {
  assert.equal(formatUptime(0), '00:00:00');
  assert.equal(formatUptime(65), '00:01:05');
  assert.equal(formatUptime(3661), '01:01:01');
});

test('formatBitrate and formatBytes format telemetry units cleanly', () => {
  assert.equal(formatBitrate(0), '0 kbps');
  assert.equal(formatBitrate(512.4), '512.4 kbps');
  assert.equal(formatBitrate(2500), '2.50 Mbps');

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

test('maskRtmpUrl masks stream key suffix', () => {
  const masked = maskRtmpUrl('rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl');
  assert.ok(masked.includes('abcd••••'));
  assert.equal(masked.includes('ijkl'), false);
});

test('validateStreamForm enforces rtsp:// and rtmp:// schemes', () => {
  const errs = validateStreamForm({
    name: 'Cam 1',
    rtsp_url: 'http://bad',
    rtmp_url: 'https://bad',
  });
  assert.ok(errs.rtsp_url);
  assert.ok(errs.rtmp_url);
  assert.equal(errs.name, undefined);

  const ok = validateStreamForm({
    name: 'Cam 1',
    rtsp_url: 'rtsp://192.168.1.10/1',
    rtmp_url: 'rtmp://a.rtmp.youtube.com/live2/key',
  });
  assert.deepEqual(ok, {});
});
