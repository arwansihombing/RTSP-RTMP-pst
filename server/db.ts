import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StreamRecord } from './stream/types';

export interface CreateStreamInput {
  name: string;
  rtsp_url: string;
  rtmp_url: string;
  enabled?: boolean;
  auto_start?: boolean;
  last_probe_width?: number | null;
  last_probe_height?: number | null;
  last_probe_fps?: string | null;
}

export interface UpdateStreamInput {
  name?: string;
  rtsp_url?: string;
  rtmp_url?: string;
  enabled?: boolean;
  auto_start?: boolean;
  last_probe_width?: number | null;
  last_probe_height?: number | null;
  last_probe_fps?: string | null;
}

const STREAM_COLUMNS =
  'id, name, rtsp_url, rtmp_url, enabled, auto_start, last_probe_width, last_probe_height, last_probe_fps, created_at, updated_at';

export class StreamDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rtsp_url TEXT NOT NULL,
        rtmp_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_start INTEGER NOT NULL DEFAULT 1,
        last_probe_width INTEGER,
        last_probe_height INTEGER,
        last_probe_fps TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const cols = this.db.prepare('PRAGMA table_info(streams)').all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (!colNames.has('auto_start')) {
      this.db.exec('ALTER TABLE streams ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 1;');
    }
    if (!colNames.has('last_probe_width')) {
      this.db.exec('ALTER TABLE streams ADD COLUMN last_probe_width INTEGER;');
    }
    if (!colNames.has('last_probe_height')) {
      this.db.exec('ALTER TABLE streams ADD COLUMN last_probe_height INTEGER;');
    }
    if (!colNames.has('last_probe_fps')) {
      this.db.exec('ALTER TABLE streams ADD COLUMN last_probe_fps TEXT;');
    }
  }

  listStreams(): StreamRecord[] {
    return this.db
      .prepare(`SELECT ${STREAM_COLUMNS} FROM streams ORDER BY created_at DESC`)
      .all() as unknown as StreamRecord[];
  }

  getStream(id: string): StreamRecord | null {
    const row = this.db
      .prepare(`SELECT ${STREAM_COLUMNS} FROM streams WHERE id = ?`)
      .get(id) as unknown as StreamRecord | undefined;
    return row ?? null;
  }

  createStream(input: CreateStreamInput): StreamRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = input.enabled === false ? 0 : 1;
    const autoStart = input.auto_start === false ? 0 : 1;

    this.db
      .prepare(
        `INSERT INTO streams (id, name, rtsp_url, rtmp_url, enabled, auto_start, last_probe_width, last_probe_height, last_probe_fps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.rtsp_url.trim(),
        input.rtmp_url.trim(),
        enabled,
        autoStart,
        input.last_probe_width ?? null,
        input.last_probe_height ?? null,
        input.last_probe_fps ?? null,
        now,
        now,
      );

    const created = this.getStream(id);
    if (!created) {
      throw new Error('Failed to load created stream');
    }
    return created;
  }

  updateStream(id: string, input: UpdateStreamInput): StreamRecord | null {
    const existing = this.getStream(id);
    if (!existing) {
      return null;
    }

    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextRtsp = input.rtsp_url !== undefined ? input.rtsp_url.trim() : existing.rtsp_url;
    const nextRtmp = input.rtmp_url !== undefined ? input.rtmp_url.trim() : existing.rtmp_url;
    const nextEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
    const nextAutoStart =
      input.auto_start !== undefined ? (input.auto_start ? 1 : 0) : existing.auto_start;
    const nextWidth =
      input.last_probe_width !== undefined ? input.last_probe_width : existing.last_probe_width;
    const nextHeight =
      input.last_probe_height !== undefined ? input.last_probe_height : existing.last_probe_height;
    const nextFps =
      input.last_probe_fps !== undefined ? input.last_probe_fps : existing.last_probe_fps;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE streams
         SET name = ?, rtsp_url = ?, rtmp_url = ?, enabled = ?, auto_start = ?, last_probe_width = ?, last_probe_height = ?, last_probe_fps = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextName,
        nextRtsp,
        nextRtmp,
        nextEnabled,
        nextAutoStart,
        nextWidth,
        nextHeight,
        nextFps,
        now,
        id,
      );

    return this.getStream(id);
  }

  deleteStream(id: string): boolean {
    const result = this.db.prepare('DELETE FROM streams WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  close(): void {
    this.db.close();
  }
}
