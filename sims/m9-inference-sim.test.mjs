// Structural harness for m9-inference-sim.html
// Run: node --test site/static/sims/m9-inference-sim.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm9-inference-sim.html');

describe('m9-inference-sim simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'controls', 'challenge', 'goal']));
  it('renders the flow, metrics and replica panels', () =>
    assertIds(html, ['flow', 'flow-panel', 'metrics', 'metrics-panel', 'replica-panel', 'replicas']));
  it('teaches the prefill/decode inference pipeline', () =>
    assertTeaches(html, ['prefill', 'decode', 'KV', 'token']));
  it('teaches the latency SLO signals (TTFT)', () =>
    assertTeaches(html, ['TTFT', 'queue']));
});
