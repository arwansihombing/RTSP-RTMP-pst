import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE_NAME = 'sb_session';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
export const LOGIN_MIN_DELAY_MS = 1_000;

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'smkbisa!!*&';

interface RateLimitEntry {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  checkLockout(ip: string, nowMs = Date.now()): { locked: boolean; retryAfterMinutes: number; lockedUntil: number } {
    const key = ip || 'unknown';
    const entry = this.entries.get(key);
    if (!entry) {
      return { locked: false, retryAfterMinutes: 0, lockedUntil: 0 };
    }
    if (entry.lockedUntil > nowMs) {
      const remainingMs = entry.lockedUntil - nowMs;
      return {
        locked: true,
        retryAfterMinutes: Math.max(1, Math.ceil(remainingMs / 60_000)),
        lockedUntil: entry.lockedUntil,
      };
    }
    if (entry.lockedUntil > 0 && nowMs >= entry.lockedUntil) {
      this.entries.delete(key);
      return { locked: false, retryAfterMinutes: 0, lockedUntil: 0 };
    }
    if (nowMs - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
      this.entries.delete(key);
    }
    return { locked: false, retryAfterMinutes: 0, lockedUntil: 0 };
  }

  recordFailure(ip: string, nowMs = Date.now()): { attempts: number; lockedUntil: number } {
    if (this.entries.size > 500) {
      this.prune(nowMs);
    }
    const key = ip || 'unknown';
    const existing = this.entries.get(key);
    if (!existing || (existing.lockedUntil === 0 && nowMs - existing.firstAttemptAt > LOGIN_WINDOW_MS) || (existing.lockedUntil > 0 && nowMs >= existing.lockedUntil)) {
      const fresh: RateLimitEntry = {
        attempts: 1,
        firstAttemptAt: nowMs,
        lockedUntil: 0,
      };
      this.entries.set(key, fresh);
      return { attempts: fresh.attempts, lockedUntil: 0 };
    }

    existing.attempts += 1;
    if (existing.attempts >= LOGIN_MAX_FAILURES) {
      existing.lockedUntil = nowMs + LOGIN_LOCKOUT_MS;
    }
    return { attempts: existing.attempts, lockedUntil: existing.lockedUntil };
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip || 'unknown');
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries.entries()) {
      const lockExpired = entry.lockedUntil > 0 && nowMs >= entry.lockedUntil;
      const windowExpired = entry.lockedUntil === 0 && nowMs - entry.firstAttemptAt > LOGIN_WINDOW_MS;
      if (lockExpired || windowExpired) {
        this.entries.delete(key);
      }
    }
  }
}

export function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export async function waitMinDelay(startedAtMs: number, minDelayMs = LOGIN_MIN_DELAY_MS): Promise<void> {
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < minDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, minDelayMs - elapsed));
  }
}

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

export function extractBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const token = match?.[1]?.trim();
  return token || undefined;
}

export function extractAllSessionTokens(req: Request): string[] {
  const tokens: string[] = [];
  const bearer = extractBearerToken(req);
  if (bearer) {
    tokens.push(bearer);
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken && !tokens.includes(cookieToken)) {
    tokens.push(cookieToken);
  }
  return tokens;
}

export function extractSessionToken(req: Request): string | undefined {
  return extractAllSessionTokens(req)[0];
}

export function resolveValidSessionToken(req: Request, store: SessionStore): string | undefined {
  for (const token of extractAllSessionTokens(req)) {
    if (store.isValid(token)) {
      return token;
    }
  }
  return undefined;
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.trim().toLowerCase().startsWith('https://')) {
    return true;
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
  if (extractBearerToken(req)) {
    return true;
  }
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

    const token = resolveValidSessionToken(req, store);
    if (!token) {
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
