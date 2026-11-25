import test from 'node:test';
import assert from 'node:assert/strict';
import { DB_PATH, FFMPEG_PATH, FFPROBE_PATH, LOG_LEVEL, PORT, loadConfig } from './config';

test('loadConfig returns hardcoded zero-config constants', () => {
  const cfg = loadConfig();
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
