import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  createApiAuthMiddleware,
  extractSessionToken,
  formatSessionCookie,
  SESSION_TTL_MS,
  SessionStore,
  verifyCredentials,
} from './server/auth';
import { loadConfig } from './server/config';
import { StreamDatabase } from './server/db';
import { createStreamsRouter } from './server/routes/streams';
import { StreamManager } from './server/stream/manager';

async function main() {
  const config = loadConfig();
  const db = new StreamDatabase(config.dbPath);
  const manager = new StreamManager(db, config);
  const sessions = new SessionStore();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Lightweight non-/api session check so login page loads with zero 401 console errors
  app.get('/auth/session', (req, res) => {
    const token = extractSessionToken(req);
    if (sessions.isValid(token)) {
      res.json({ authenticated: true, username: 'admin' });
    } else {
      res.json({ authenticated: false });
    }
  });

  app.post('/api/login', (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!verifyCredentials(username, password)) {
      res.status(401).json({ error: 'Username atau password salah' });
      return;
    }

    const token = sessions.createSession();
    res.setHeader(
      'Set-Cookie',
      formatSessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)),
    );
    res.json({ ok: true, username: 'admin' });
  });

  // All /api/* routes except POST /api/login require a valid session cookie
  app.use('/api', createApiAuthMiddleware(sessions));

  app.post('/api/logout', (req, res) => {
    const token = extractSessionToken(req);
    sessions.deleteSession(token);
    res.setHeader('Set-Cookie', formatSessionCookie(req, '', 0));
    res.json({ ok: true });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', createStreamsRouter(manager));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      throw new Error('Production build not found in dist/. Run "npm run build" first.');
    }
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '365d',
        immutable: true,
      }),
    );
    app.use(express.static(distDir, { index: false }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `StreamBridge (${isProd ? 'production' : 'development'}) listening on http://0.0.0.0:${config.port}`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, stopping all FFmpeg child processes...`);
    await manager.stopAll();
    db.close();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 6_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
