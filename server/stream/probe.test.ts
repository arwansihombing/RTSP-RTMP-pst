import test from 'node:test';
import assert from 'node:assert/strict';
import { NON_H264_ERROR, parseFfprobeJson } from './probe';

test('parseFfprobeJson accepts H.264 video-only DVR stream', () => {
  const json = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        avg_frame_rate: '25/1',
      },
    ],
  });

  const res = parseFfprobeJson(json);
  assert.equal(res.ok, true);
  assert.equal(res.codec_name, 'h264');
  assert.equal(res.width, 1920);
  assert.equal(res.height, 1080);
  assert.equal(res.has_audio, false);
});

test('parseFfprobeJson rejects HEVC stream with explicit non-H.264 message', () => {
  const json = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 2560,
        height: 1440,
      },
    ],
  });

  const res = parseFfprobeJson(json);
  assert.equal(res.ok, false);
  assert.equal(res.codec_name, 'hevc');
  assert.ok(res.message.startsWith(NON_H264_ERROR));
});

test('parseFfprobeJson rejects stream with no video track', () => {
  const res = parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }));
  assert.equal(res.ok, false);
  assert.match(res.message, /No video stream/);
});
