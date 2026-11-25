import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import {
  extractBearerToken,
  extractSessionToken,
  formatSessionCookie,
  parseCookieHeader,
  resolveValidSessionToken,
  SESSION_TTL_MS,
  SessionStore,
  verifyCredentials,
} from './auth';

test('verifyCredentials accepts exact admin credentials and rejects others', () => {
  assert.equal(verifyCredentials('admin', 'smkbisa'), true);
  assert.equal(verifyCredentials('admin', 'smk bisa'), false);
  assert.equal(verifyCredentials('admin', 'smkbisa!!*&'), false);
  assert.equal(verifyCredentials('admin', 'wrong'), false);
  assert.equal(verifyCredentials('root', 'smkbisa'), false);
});

test('SessionStore creates, validates, expires after 24h, and deletes tokens', () => {
  const store = new SessionStore();
  const t0 = 1_000_000;
  const token = store.createSession(t0);

  assert.equal(store.isValid(token, t0 + 1000), true);
  assert.equal(store.isValid(token, t0 + SESSION_TTL_MS), false);

  const token2 = store.createSession(t0);
  assert.equal(store.isValid(token2, t0 + 10), true);
  store.deleteSession(token2);
  assert.equal(store.isValid(token2, t0 + 10), false);
});

test('parseCookieHeader parses HttpOnly session cookie safely', () => {
  const parsed = parseCookieHeader('foo=bar; sb_session=abc-123; theme=light');
  assert.equal(parsed.sb_session, 'abc-123');
  assert.equal(parsed.foo, 'bar');
});

test('extractBearerToken and resolveValidSessionToken work when cookies are blocked', () => {
  const store = new SessionStore();
  const validToken = store.createSession();

  const reqBearerOnly = {
    headers: { authorization: `Bearer ${validToken}` },
  } as unknown as Request;
  assert.equal(extractBearerToken(reqBearerOnly), validToken);
  assert.equal(extractSessionToken(reqBearerOnly), validToken);
  assert.equal(resolveValidSessionToken(reqBearerOnly, store), validToken);

  const reqStaleCookieValidBearer = {
    headers: {
      cookie: 'sb_session=stale-expired-token',
      authorization: `Bearer ${validToken}`,
    },
  } as unknown as Request;
  assert.equal(resolveValidSessionToken(reqStaleCookieValidBearer, store), validToken);

  const reqStaleBearerValidCookie = {
    headers: {
      cookie: `sb_session=${validToken}`,
      authorization: 'Bearer stale-token',
    },
  } as unknown as Request;
  assert.equal(resolveValidSessionToken(reqStaleBearerValidCookie, store), validToken);
});

test('formatSessionCookie enables SameSite=None Secure when HTTPS origin is present', () => {
  const req = {
    secure: false,
    headers: { origin: 'https://preview.example.com' },
  } as unknown as Request;
  const cookie = formatSessionCookie(req, 'tok-123', 3600);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
});
