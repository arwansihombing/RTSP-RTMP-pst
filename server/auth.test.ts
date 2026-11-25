import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookieHeader, SESSION_TTL_MS, SessionStore, verifyCredentials } from './auth';

test('verifyCredentials accepts exact admin credentials and rejects others', () => {
  assert.equal(verifyCredentials('admin', 'smk bisa'), true);
  assert.equal(verifyCredentials('admin', 'smkbisa!!*&'), false);
  assert.equal(verifyCredentials('admin', 'wrong'), false);
  assert.equal(verifyCredentials('root', 'smk bisa'), false);
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
