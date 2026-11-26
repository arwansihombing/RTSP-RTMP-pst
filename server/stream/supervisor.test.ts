import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialRuntime,
  getBackoffSeconds,
  hasExceededMaxRetries,
  runSupervisorLoop,
  shouldResetRetries,
  StreamLogBuffer,
  terminateChildGracefully,
} from './supervisor';

test('getBackoffSeconds follows 3, 5, 10, 30, 60 progression', () => {
  assert.equal(getBackoffSeconds(1), 3);
  assert.equal(getBackoffSeconds(2), 5);
  assert.equal(getBackoffSeconds(3), 10);
  assert.equal(getBackoffSeconds(4), 30);
  assert.equal(getBackoffSeconds(5), 60);
  assert.equal(getBackoffSeconds(8), 60);
});

test('shouldResetRetries triggers after 60 seconds and max retries triggers past 10', () => {
  assert.equal(shouldResetRetries(59_999), false);
  assert.equal(shouldResetRetries(61_000), true);
  assert.equal(hasExceededMaxRetries(10), false);
  assert.equal(hasExceededMaxRetries(11), true);
});

test('StreamLogBuffer caps entries at 200 lines and masks RTSP/RTMP secrets', () => {
  const buf = new StreamLogBuffer(200);
  for (let i = 1; i <= 250; i += 1) {
    buf.push(
      'info',
      `line-${i} rtsp://admin:secretpass@192.168.1.50/101 rtmp://a.rtmp.youtube.com/live2/xxxx-yyyy-abcd`,
    );
  }
  const list = buf.list();
  assert.equal(list.length, 200);
  assert.equal(list[0].message.includes('line-51'), true);
  assert.equal(list[199].message.includes('line-250'), true);
  assert.equal(list[199].message.includes('secretpass'), false);
  assert.equal(list[199].message.includes('xxxx-yyyy'), false);
  assert.equal(list[199].message.includes('****-****-abcd'), true);
});

test('terminateChildGracefully escalates to SIGKILL after 5s when SIGTERM is ignored', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Child did not emit READY')), 4000);
    child.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('READY')) {
        clearTimeout(t);
        resolve();
      }
    });
  });

  const startedAt = Date.now();
  await terminateChildGracefully(child, 5_000);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 4_500 && elapsed < 9_000, `Expected ~5s kill escalation, got ${elapsed}ms`);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('runSupervisorLoop stops without retrying on fatal YouTube RTMP error', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fatal-'));
  const scriptPath = path.join(tmpDir, 'fake-ffmpeg.sh');
  fs.writeFileSync(
    scriptPath,
    '#!/bin/sh\necho "RTMP_SendPacket: NetStream.Publish.BadName" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  try {
    const rt = createInitialRuntime('test-fatal');
    await runSupervisorLoop(rt, scriptPath, () => ({
      name: 'Fatal Test Cam',
      rtsp_url: 'rtsp://127.0.0.1:554/1',
      rtmp_url: 'rtmp://a.rtmp.youtube.com/live2/xxxx-yyyy-1234',
    }));

    assert.equal(rt.status, 'error');
    assert.equal(rt.retryCount, 0);
    assert.match(rt.lastError ?? '', /YouTube Studio/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runSupervisorLoop stall watchdog kills hung FFmpeg process and triggers reconnect', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stall-'));
  const scriptPath = path.join(tmpDir, 'stalled-ffmpeg.sh');
  fs.writeFileSync(
    scriptPath,
    '#!/bin/sh\necho "total_size=0"\necho "progress=continue"\nexec sleep 10\n',
    { mode: 0o755 },
  );

  try {
    const rt = createInitialRuntime('test-stall');
    const loop = runSupervisorLoop(
      rt,
      scriptPath,
      () => ({
        name: 'Stall Test Cam',
        rtsp_url: 'rtsp://127.0.0.1:554/1',
        rtmp_url: 'rtmp://a.rtmp.youtube.com/live2/xxxx-yyyy-1234',
      }),
      { stallTimeoutMs: 350, watchdogIntervalMs: 80 },
    );

    await new Promise((r) => setTimeout(r, 700));
    rt.stopRequested = true;
    rt.wakeSleep?.();
    await loop;

    const logs = rt.logs.list().map((l) => l.message);
    assert.ok(logs.some((m) => m.includes('Stream stall')), `Expected stall log, got: ${logs.join('; ')}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
