import test from 'node:test';
import assert from 'node:assert/strict';
import { BandwidthMonitor, MAX_BANDWIDTH_HISTORY, parseProcNetDev } from './bandwidth';

test('parseProcNetDev parses non-loopback RX and TX byte counters', () => {
  const sample = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1000000    100    0    0    0     0          0         0  1000000    100    0    0    0     0       0          0',
    '  eth0: 5000000    500    0    0    0     0          0         0  2500000    300    0    0    0     0       0          0',
    '  eth1:  250000     25    0    0    0     0          0         0   100000     10    0    0    0     0       0          0',
  ].join('\n');

  const totals = parseProcNetDev(sample);
  assert.equal(totals.rxBytes, 5_250_000);
  assert.equal(totals.txBytes, 2_600_000);
  assert.equal(totals.interfaceCount, 2);
});

test('BandwidthMonitor aggregates active stream egress and caps history at 60 samples', async () => {
  let egress = 2450.5;
  const monitor = new BandwidthMonitor(() => ({
    egressKbps: egress,
    totalBytesSent: 12_345_678,
    activeStreams: 2,
  }));

  for (let i = 0; i < 65; i += 1) {
    await monitor.sampleOnce();
  }

  const snap = monitor.getSnapshot();
  assert.equal(snap.stream_egress_kbps, 2450.5);
  assert.equal(snap.total_bytes_sent, 12_345_678);
  assert.equal(snap.active_streams, 2);
  assert.equal(snap.history.length, MAX_BANDWIDTH_HISTORY);

  egress = 0;
  assert.equal(monitor.getSnapshot().stream_egress_kbps, 0);
});
