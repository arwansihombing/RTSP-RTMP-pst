import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBitrate,
  formatBytes,
  formatProbeFps,
  formatUptime,
  maskRtmpUrl,
  validateStreamForm,
} from './streamFormat';

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

test('maskRtmpUrl masks stream key leaving only last 4 chars', () => {
  const masked = maskRtmpUrl('rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl');
  assert.ok(masked.includes('****-****-ijkl'));
  assert.equal(masked.includes('abcd'), false);
});

test('formatProbeFps parses FFprobe fraction and decimal FPS values', () => {
  assert.equal(formatProbeFps('25/1'), '25 fps');
  assert.equal(formatProbeFps('30000/1001'), '29.97 fps');
  assert.equal(formatProbeFps('0/0'), null);
  assert.equal(formatProbeFps(null), null);
});

test('validateStreamForm enforces rtsp:// and rtmp:// schemes and allows blank URLs on edit', () => {
  const errs = validateStreamForm({
    name: 'Cam 1',
    rtsp_url: 'http://bad',
    rtmp_url: 'https://bad',
  });
  assert.ok(errs.rtsp_url);
  assert.ok(errs.rtmp_url);
  assert.equal(errs.name, undefined);

  const editOk = validateStreamForm({
    name: 'Cam 1',
    rtsp_url: '',
    rtmp_url: '',
    isEditing: true,
  });
  assert.deepEqual(editOk, {});

  const ok = validateStreamForm({
    name: 'Cam 1',
    rtsp_url: 'rtsp://192.168.1.10/1',
    rtmp_url: 'rtmp://a.rtmp.youtube.com/live2/key',
  });
  assert.deepEqual(ok, {});
});
