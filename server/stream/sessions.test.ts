import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { StreamDatabase } from '../db';
import { StreamManager } from './manager';
import { maskCommandUrls, parsePsFfmpegProcesses } from './sessions';

test('parsePsFfmpegProcesses classifies managed vs orphan ffmpeg and masks RTMP keys', () => {
  const samplePs = [
    '  101     1   120 ffmpeg -hide_banner -rtsp_transport tcp -i rtsp://admin:secret@192.168.1.50:554/101 -c:v copy -f flv rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl',
    '  202     1    45 /usr/bin/ffmpeg -hide_banner -rtsp_transport tcp -i rtsp://10.0.0.2/cam -c:v copy -f flv rtmp://a.rtmp.youtube.com/live2/zzzz-9999',
    '  303     1     1 ffprobe -v quiet -show_streams rtsp://10.0.0.2/cam',
    '  404   100     0 grep ffmpeg',
  ].join('\n');

  const known = new Map([[101, { streamId: 's1', streamName: 'Selasar TKJ1' }]]);
  const parsed = parsePsFfmpegProcesses(samplePs, known);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].pid, 101);
  assert.equal(parsed[0].managed, true);
  assert.equal(parsed[0].stream_name, 'Selasar TKJ1');
  assert.equal(parsed[0].streambridge_signature, true);
  assert.equal(parsed[0].command.includes('secret'), false);
  assert.equal(parsed[0].command.includes('abcd-efgh-ijkl'), false);
  assert.equal(parsed[0].command.includes('****-****-ijkl'), true);

  assert.equal(parsed[1].pid, 202);
  assert.equal(parsed[1].managed, false);
  assert.equal(parsed[1].streambridge_signature, true);
});

test('maskCommandUrls preserves non-secret path segments and masks passwords and stream keys', () => {
  const masked = maskCommandUrls(
    'ffmpeg -i rtsp://user:mypass@192.168.1.10:554/ch1 rtmp://a.rtmp.youtube.com/live2/1234-5678-90ab',
  );
  assert.equal(masked.includes('mypass'), false);
  assert.equal(masked.includes('1234-5678-90ab'), false);
  assert.equal(masked.includes('****-****-90ab'), true);
});

test('StreamManager masks secrets in StreamView and prevents duplicate active RTMP session', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sess-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new StreamDatabase(dbPath);
  const cfg = { ...loadConfig([]), dbPath, ffmpegPath: 'true' };
  const manager = new StreamManager(db, cfg);

  try {
    const sharedRtmp = 'rtmp://a.rtmp.youtube.com/live2/aaaa-bbbb-9999';
    const first = await manager.createStream({
      name: 'Cam 1',
      rtsp_url: 'rtsp://admin:camsecret@127.0.0.1:554/1',
      rtmp_url: sharedRtmp,
      skip_probe: true,
    });

    assert.equal(first.stream.rtsp_url_masked, 'rtsp://admin:****@127.0.0.1:554/1');
    assert.equal(first.stream.rtmp_url_masked, 'rtmp://a.rtmp.youtube.com/live2/****-****-9999');
    assert.equal(JSON.stringify(first.stream).includes('camsecret'), false);
    assert.equal(JSON.stringify(first.stream).includes('aaaa-bbbb'), false);

    const second = await manager.createStream({
      name: 'Cam 2',
      rtsp_url: 'rtsp://127.0.0.1:554/2',
      rtmp_url: sharedRtmp,
      skip_probe: true,
    });

    await manager.startStream(first.stream.id, true);

    await assert.rejects(
      () => manager.startStream(second.stream.id, true),
      /already in use by active session "Cam 1"/,
    );
  } finally {
    await manager.stopAll();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
