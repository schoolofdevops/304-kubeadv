// Structural harness for m8-scheduling-sim.html
// Run: node --test site/static/sims/m8-scheduling-sim.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm8-scheduling-sim.html');

describe('m8-scheduling-sim simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'controls', 'challenge', 'status', 'goal']));
  it('renders the device, queue and GPU panels', () =>
    assertIds(html, ['device-panel', 'queue-panel', 'queue-view', 'gpu-grid', 'events']));
  it('teaches the DRA allocation model', () =>
    assertTeaches(html, ['DRA', 'ResourceClaim']));
  it('teaches the Kueue admission / preemption transitions', () =>
    assertTeaches(html, ['Kueue', 'ClusterQueue', 'quota', 'suspend', 'preempt']));
});
