import test from 'node:test';
import assert from 'node:assert/strict';
import { DB_PATH, FFMPEG_PATH, FFPROBE_PATH, LOG_LEVEL, PORT, loadConfig, resolveDbPath, resolvePort } from './config';

test('loadConfig returns hardcoded zero-config constants', () => {
  const cfg = loadConfig([]);
  assert.equal(cfg.port, 3000);
  assert.equal(PORT, 3000);
  assert.equal(cfg.dbPath, './data.db');
  assert.equal(DB_PATH, './data.db');
  assert.equal(cfg.ffmpegPath, 'ffmpeg');
  assert.equal(FFMPEG_PATH, 'ffmpeg');
  assert.equal(cfg.ffprobePath, 'ffprobe');
  assert.equal(FFPROBE_PATH, 'ffprobe');
  assert.equal(cfg.rustLog, 'info');
  assert.equal(LOG_LEVEL, 'info');
});

test('resolvePort overrides default 3000 only when valid --port or -p flag is passed', () => {
  assert.equal(resolvePort([]), 3000);
  assert.equal(resolvePort(['--port', '3005']), 3005);
  assert.equal(resolvePort(['--port=3010']), 3010);
  assert.equal(resolvePort(['-p', '8080']), 8080);
  assert.equal(resolvePort(['--port', 'invalid']), 3000);
  assert.equal(loadConfig(['--port', '3005']).port, 3005);
});

test('resolveDbPath overrides default ./data.db when --db flag is passed', () => {
  assert.equal(resolveDbPath([]), './data.db');
  assert.equal(resolveDbPath(['--db', '/app/data/data.db']), '/app/data/data.db');
  assert.equal(resolveDbPath(['--db=/var/lib/streambridge/data.db']), '/var/lib/streambridge/data.db');
  assert.equal(resolveDbPath(['--db', '']), './data.db');
  assert.equal(loadConfig(['--db', '/app/data/data.db']).dbPath, '/app/data/data.db');
});
