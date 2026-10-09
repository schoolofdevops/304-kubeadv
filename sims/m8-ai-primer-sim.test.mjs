// Structural harness for m8-ai-primer-sim.html
// Run: node --test site/static/sims/m8-ai-primer-sim.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm8-ai-primer-sim.html');

describe('m8-ai-primer-sim simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has required interactive controls', () =>
    assertIds(html, ['app', 'controls', 'run', 'reset', 'workers', 'status', 'eventLog', 'challenge', 'goal']));
  it('exposes primer state and challenge controls', () =>
    assertIds(html, ['modeBtns', 'modelBtns', 'topoBtns', 'workersVal', 'next', 'd1', 'd2', 'd3']));
  it('renders capacity and timing outputs', () =>
    assertIds(html, ['memNeed', 'stepMs', 'computeMs', 'commMs', 'computeFill', 'commFill', 'dominion', 'fitBadge', 'throughput']));
  it('contains teaching phrases for AI infrastructure concepts', () =>
    assertTeaches(html, ['HBM', 'PCIe', 'NVLink', 'RDMA', 'Ethernet', 'throughput', 'all-reduce', 'topology']));
  it('exposes a safe runtime hook', () =>
    assertTeaches(html, ['window.__primerSim']));
});
