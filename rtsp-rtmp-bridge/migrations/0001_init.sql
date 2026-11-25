CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    rtsp_url TEXT NOT NULL,
    rtmp_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_streams_created_at ON streams (created_at DESC);
