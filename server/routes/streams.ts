import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { extractClientIp } from '../auth';
import type { StreamManager } from '../stream/manager';

function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected server error';
}

const RAW_ACCESS_WINDOW_MS = 60_000;
const RAW_ACCESS_MAX_PER_WINDOW = 10;

export function createStreamsRouter(manager: StreamManager): Router {
  const router = Router();
  const rawRateMap = new Map<string, { count: number; resetAt: number }>();

  function checkRawRateLimit(ip: string): boolean {
    const now = Date.now();
    if (rawRateMap.size > 500) {
      for (const [key, item] of rawRateMap.entries()) {
        if (now >= item.resetAt) {
          rawRateMap.delete(key);
        }
      }
    }
    const entry = rawRateMap.get(ip);
    if (!entry || now >= entry.resetAt) {
      rawRateMap.set(ip, { count: 1, resetAt: now + RAW_ACCESS_WINDOW_MS });
      return true;
    }
    if (entry.count >= RAW_ACCESS_MAX_PER_WINDOW) {
      return false;
    }
    entry.count += 1;
    return true;
  }

  router.get('/streams', (_req: Request, res: Response) => {
    res.json({ streams: manager.listStreams() });
  });

  router.get('/streams/export', (_req: Request, res: Response) => {
    res.json(manager.exportStreams());
  });

  router.post('/streams/import', (req: Request, res: Response) => {
    try {
      const items = Array.isArray(req.body) ? req.body : req.body?.streams;
      const result = manager.importStreams(items);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: extractErrorMessage(err) });
    }
  });

  router.post('/streams/stop-all', async (_req: Request, res: Response) => {
    const result = await manager.stopAllManual();
    res.json({ ok: true, ...result });
  });

  router.post('/streams/restart-all', async (_req: Request, res: Response) => {
    const result = await manager.restartAllEnabled(500);
    res.json({ ok: true, ...result });
  });

  router.get('/streams/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const wantRaw = req.query.raw === '1' || req.query.raw === 'true';
    if (wantRaw) {
      const ip = extractClientIp(req);
      if (!checkRawRateLimit(ip)) {
        res.status(429).json({ error: 'Terlalu banyak permintaan detail stream. Coba lagi sebentar.' });
        return;
      }
      const rawStream = manager.getRawStream(id);
      if (!rawStream) {
        res.status(404).json({ error: 'Stream not found' });
        return;
      }
      res.json({ stream: rawStream });
      return;
    }

    const stream = manager.getStream(id);
    if (!stream) {
      res.status(404).json({ error: 'Stream not found' });
      return;
    }
    res.json({ stream });
  });

  router.get('/bandwidth', (_req: Request, res: Response) => {
    res.json(manager.getBandwidthSnapshot());
  });

  router.get('/sessions', async (_req: Request, res: Response) => {
    res.json(await manager.listOsFfmpegSessions());
  });

  router.post('/sessions/cleanup', async (_req: Request, res: Response) => {
    res.json(await manager.cleanupOrphanFfmpegSessions());
  });

  router.post('/probe', async (req: Request, res: Response) => {
    const rtspUrl = typeof req.body?.rtsp_url === 'string' ? req.body.rtsp_url : '';
    if (!rtspUrl.trim()) {
      res.status(400).json({ error: 'rtsp_url is required' });
      return;
    }

    try {
      const result = await manager.probeUrl(rtspUrl);
      if (!result.ok) {
        res.status(422).json({ error: result.message, probe: result });
        return;
      }
      res.json({ probe: result });
    } catch (err) {
      res.status(400).json({ error: extractErrorMessage(err) });
    }
  });

  router.post('/streams', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    const rtspUrl = typeof body.rtsp_url === 'string' ? body.rtsp_url : '';
    const rtmpUrl = typeof body.rtmp_url === 'string' ? body.rtmp_url : '';
    const skipProbe = Boolean(body.skip_probe);
    const startNow =
      typeof body.start_now === 'boolean' ? body.start_now : Boolean(body.auto_start);
    const autoStartOnBoot =
      typeof body.auto_start === 'boolean' && typeof body.start_now === 'boolean'
        ? body.auto_start
        : true;
    const probeCache =
      body.probe_cache && typeof body.probe_cache === 'object' ? body.probe_cache : null;

    if (!name.trim() || !rtspUrl.trim() || !rtmpUrl.trim()) {
      res.status(400).json({ error: 'name, rtsp_url, and rtmp_url are required' });
      return;
    }

    try {
      const result = await manager.createStream({
        name,
        rtsp_url: rtspUrl,
        rtmp_url: rtmpUrl,
        skip_probe: skipProbe,
        start_now: startNow,
        auto_start: autoStartOnBoot,
        probe_cache: probeCache,
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = extractErrorMessage(err);
      const status = msg.includes('H.264') || msg.includes('FFprobe') ? 422 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.patch('/streams/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body ?? {};
    try {
      const updated = await manager.updateStream(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        rtsp_url: typeof body.rtsp_url === 'string' ? body.rtsp_url : undefined,
        rtmp_url: typeof body.rtmp_url === 'string' ? body.rtmp_url : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        auto_start: typeof body.auto_start === 'boolean' ? body.auto_start : undefined,
      });

      if (!updated) {
        res.status(404).json({ error: 'Stream not found' });
        return;
      }
      res.json({ stream: updated });
    } catch (err) {
      res.status(400).json({ error: extractErrorMessage(err) });
    }
  });

  router.delete('/streams/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const deleted = await manager.deleteStream(id);
    if (!deleted) {
      res.status(404).json({ error: 'Stream not found' });
      return;
    }
    res.json({ deleted: true, id });
  });

  router.post('/streams/:id/start', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const skipProbe = Boolean(req.body?.skip_probe);
    try {
      const stream = await manager.startStream(id, skipProbe);
      if (!stream) {
        res.status(404).json({ error: 'Stream not found' });
        return;
      }
      res.json({ stream });
    } catch (err) {
      const msg = extractErrorMessage(err);
      res.status(422).json({ error: msg });
    }
  });

  router.post('/streams/:id/stop', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const stream = await manager.stopStream(id, { persistStopFlag: true });
    if (!stream) {
      res.status(404).json({ error: 'Stream not found' });
      return;
    }
    res.json({ stream });
  });

  router.post('/streams/:id/probe', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const probe = await manager.probeStreamById(id);
      if (!probe) {
        res.status(404).json({ error: 'Stream not found' });
        return;
      }
      if (!probe.ok) {
        res.status(422).json({ error: probe.message, probe });
        return;
      }
      res.json({ probe });
    } catch (err) {
      res.status(400).json({ error: extractErrorMessage(err) });
    }
  });

  router.get('/streams/:id/logs', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const logs = manager.getLogs(id);
    if (!logs) {
      res.status(404).json({ error: 'Stream not found' });
      return;
    }
    res.json({ logs });
  });

  router.get('/rust-files', async (_req: Request, res: Response) => {
    const rustRoot = path.resolve(process.cwd(), 'rtsp-rtmp-bridge');
    const relativePaths = [
      'Cargo.toml',
      'README.md',
      'migrations/0001_init.sql',
      'src/main.rs',
      'src/auth.rs',
      'src/config.rs',
      'src/db.rs',
      'src/models.rs',
      'src/error.rs',
      'src/routes/mod.rs',
      'src/routes/streams.rs',
      'src/stream/mod.rs',
      'src/stream/manager.rs',
      'src/stream/ffmpeg.rs',
      'src/stream/probe.rs',
      'src/stream/supervisor.rs',
      'frontend/index.html',
      'frontend/app.js',
    ];

    const files: Array<{ path: string; content: string }> = [];
    for (const rel of relativePaths) {
      const resolved = path.resolve(rustRoot, rel);
      if (!resolved.startsWith(rustRoot + path.sep)) {
        continue;
      }
      try {
        const content = await fs.readFile(resolved, 'utf8');
        files.push({ path: rel, content });
      } catch {
        // skip if not yet generated
      }
    }

    res.json({ files });
  });

  return router;
}
