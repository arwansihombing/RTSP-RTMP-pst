import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFfmpegArgs,
  classifyFfmpegStderr,
  parseBitrateValue,
  parseFfmpegProgressFields,
  validateStreamUrl,
} from './ffmpeg';

test('buildFfmpegArgs produces exact passthrough flags plus -progress pipe:1 without audio mapping', () => {
  const args = buildFfmpegArgs(
    'rtsp://192.168.1.100:554/Streaming/Channels/101',
    'rtmp://a.rtmp.youtube.com/live2/xxxx-yyyy',
  );

  assert.deepEqual(args, [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-rtsp_transport',
    'tcp',
    '-use_wallclock_as_timestamps',
    '1',
    '-fflags',
    '+genpts',
    '-i',
    'rtsp://192.168.1.100:554/Streaming/Channels/101',
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-an',
    '-avoid_negative_ts',
    'make_zero',
    '-f',
    'flv',
    '-flvflags',
    'no_duration_filesize',
    '-max_interleave_delta',
    '0',
    '-progress',
    'pipe:1',
    'rtmp://a.rtmp.youtube.com/live2/xxxx-yyyy',
  ]);

  assert.equal(args.includes('0:a'), false);
  assert.equal(args.includes('-c:a'), false);
});

test('parseBitrateValue and parseFfmpegProgressFields parse FFmpeg stdout progress', () => {
  assert.equal(parseBitrateValue('2048.5kbits/s'), 2048.5);
  assert.equal(parseBitrateValue('1.5Mbits/s'), 1500);
  assert.equal(parseBitrateValue('N/A'), null);

  const parsed = parseFfmpegProgressFields({
    fps: '25.00',
    bitrate: '1536.0kbits/s',
    total_size: '1048576',
    progress: 'continue',
  });
  assert.equal(parsed.bitrateKbps, 1536);
  assert.equal(parsed.totalSizeBytes, 1048576);
  assert.equal(parsed.fps, 25);
});

test('validateStreamUrl rejects invalid schemes and control characters', () => {
  assert.throws(() => validateStreamUrl('http://example.com/stream', ['rtsp:']), /must start with/);
  assert.throws(() => validateStreamUrl('rtsp://host/path\n-vf scale=1', ['rtsp:']), /control characters/);
  assert.equal(validateStreamUrl('  rtsp://10.0.0.5:554/cam1  ', ['rtsp:']), 'rtsp://10.0.0.5:554/cam1');
});

test('classifyFfmpegStderr detects DTS warnings, fatal RTMP rejection, connection errors, and audio map bugs', () => {
  const dts = classifyFfmpegStderr('Non-monotonous DTS in output stream 0:0; previous: 100, current: 90');
  assert.equal(dts.severity, 'warn');
  assert.equal(dts.shouldRestart, false);
  assert.equal(dts.fatalNoRetry, false);

  const unset = classifyFfmpegStderr('[flv @ 0x123] Timestamps are unset in a packet for stream 0.');
  assert.equal(unset.severity, 'warn');
  assert.equal(unset.shouldRestart, false);

  const badName = classifyFfmpegStderr('RTMP_SendPacket: NetStream.Publish.BadName');
  assert.equal(badName.severity, 'error');
  assert.equal(badName.fatalNoRetry, true);
  assert.equal(badName.shouldRestart, false);
  assert.match(badName.summary ?? '', /YouTube Studio/);

  const auth403 = classifyFfmpegStderr('HTTP error 403 Forbidden from server');
  assert.equal(auth403.fatalNoRetry, true);

  const already = classifyFfmpegStderr('NetStream.Publish.Rejected: AlreadyPublishing');
  assert.equal(already.fatalNoRetry, true);

  const refused = classifyFfmpegStderr('tcp://192.168.1.50:554: Connection refused');
  assert.equal(refused.severity, 'error');
  assert.equal(refused.shouldRestart, true);
  assert.equal(refused.fatalNoRetry, false);

  const audioMap = classifyFfmpegStderr("Stream map '0:a' matches no streams.");
  assert.equal(audioMap.severity, 'critical');
  assert.equal(audioMap.shouldRestart, true);
});
