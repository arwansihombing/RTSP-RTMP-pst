import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  createApiAuthMiddleware,
  extractAllSessionTokens,
  extractClientIp,
  formatSessionCookie,
  LoginRateLimiter,
  resolveValidSessionToken,
  SESSION_TTL_MS,
  SessionStore,
  verifyCredentials,
  waitMinDelay,
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
  const loginLimiter = new LoginRateLimiter();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.get(['/health', '/healthz'], (_req, res) => {
    try {
      db.ping();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'Database unavailable' });
    }
  });

  // Lightweight non-/api session check so login page loads with zero 401 console errors
  app.get('/auth/session', (req, res) => {
    const token = resolveValidSessionToken(req, sessions);
    if (token) {
      res.json({ authenticated: true, username: 'admin' });
    } else {
      res.json({ authenticated: false });
    }
  });

  app.post('/api/login', async (req, res) => {
    const startedAt = Date.now();
    const clientIp = extractClientIp(req);
    const lockState = loginLimiter.checkLockout(clientIp, startedAt);
    if (lockState.locked) {
      res.status(429).json({
        error: `Terlalu banyak percobaan. Coba lagi dalam ${lockState.retryAfterMinutes} menit.`,
      });
      return;
    }

    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const valid = verifyCredentials(username, password);

    await waitMinDelay(startedAt);

    if (!valid) {
      loginLimiter.recordFailure(clientIp);
      res.status(401).json({ error: 'Username atau password salah' });
      return;
    }

    loginLimiter.recordSuccess(clientIp);
    const token = sessions.createSession();
    res.setHeader(
      'Set-Cookie',
      formatSessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)),
    );
    res.json({ ok: true, username: 'admin', token });
  });

  // All /api/* routes except POST /api/login require a valid session cookie or Bearer token
  app.use('/api', createApiAuthMiddleware(sessions));

  app.post('/api/logout', (req, res) => {
    for (const token of extractAllSessionTokens(req)) {
      sessions.deleteSession(token);
    }
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
    const { createServer: createViteServer } = await import('vite');
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
    void manager.autoStartOnBoot(500);
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
