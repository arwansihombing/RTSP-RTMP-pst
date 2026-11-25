import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBackoffSeconds,
  hasExceededMaxRetries,
  shouldResetRetries,
  StreamLogBuffer,
} from './supervisor';

test('getBackoffSeconds follows 3, 5, 10, 30, 60 progression', () => {
  assert.equal(getBackoffSeconds(1), 3);
  assert.equal(getBackoffSeconds(2), 5);
  assert.equal(getBackoffSeconds(3), 10);
  assert.equal(getBackoffSeconds(4), 30);
  assert.equal(getBackoffSeconds(5), 60);
  assert.equal(getBackoffSeconds(8), 60);
});

test('shouldResetRetries triggers after 60 seconds and max retries triggers past 10', () => {
  assert.equal(shouldResetRetries(59_999), false);
  assert.equal(shouldResetRetries(61_000), true);
  assert.equal(hasExceededMaxRetries(10), false);
  assert.equal(hasExceededMaxRetries(11), true);
});

test('StreamLogBuffer caps entries at 200 lines', () => {
  const buf = new StreamLogBuffer(200);
  for (let i = 1; i <= 250; i += 1) {
    buf.push('info', `line-${i}`);
  }
  const list = buf.list();
  assert.equal(list.length, 200);
  assert.equal(list[0].message, 'line-51');
  assert.equal(list[199].message, 'line-250');
});
