import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE_NAME = 'sb_session';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'smk bisa';

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifyCredentials(username: string, password: string): boolean {
  return safeEquals(username, ADMIN_USERNAME) && safeEquals(password, ADMIN_PASSWORD);
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export class SessionStore {
  private readonly sessions = new Map<string, number>();

  createSession(nowMs = Date.now()): string {
    this.pruneExpired(nowMs);
    const token = randomUUID();
    this.sessions.set(token, nowMs + SESSION_TTL_MS);
    return token;
  }

  isValid(token: string | undefined, nowMs = Date.now()): boolean {
    if (!token) {
      return false;
    }
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) {
      return false;
    }
    if (nowMs >= expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  deleteSession(token: string | undefined): void {
    if (token) {
      this.sessions.delete(token);
    }
  }

  private pruneExpired(nowMs: number): void {
    for (const [token, expiresAt] of this.sessions.entries()) {
      if (nowMs >= expiresAt) {
        this.sessions.delete(token);
      }
    }
  }
}

export function extractSessionToken(req: Request): string | undefined {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME];
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

export function formatSessionCookie(req: Request, token: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (isHttpsRequest(req)) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }

  return parts.join('; ');
}

function hasValidOriginOrHeader(req: Request): boolean {
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return true;
  }
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] || req.headers.host) as string | undefined;
  if (typeof origin === 'string' && typeof host === 'string') {
    try {
      const parsedOrigin = new URL(origin);
      return parsedOrigin.host === host.split(',')[0].trim();
    } catch {
      return false;
    }
  }
  return false;
}

export function createApiAuthMiddleware(store: SessionStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/login' && req.method === 'POST') {
      next();
      return;
    }

    const token = extractSessionToken(req);
    if (!store.isValid(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD' && !hasValidOriginOrHeader(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    next();
  };
}
