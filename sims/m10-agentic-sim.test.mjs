// Structural harness for m10-agentic-sim.html
// Run: node --test site/static/sims/m10-agentic-sim.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm10-agentic-sim.html');

describe('m10-agentic-sim simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'controls', 'challenge', 'goal', 'dots']));
  it('teaches the agent control-loop model', () =>
    assertTeaches(html, ['agent', 'loop', 'tool']));
  it('teaches the MCP / least-privilege access model', () =>
    assertTeaches(html, ['MCP', 'ClusterRole']));
});
