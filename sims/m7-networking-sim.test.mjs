// Structural harness for m7-networking-sim.html
// Run: node --test site/static/sims/m7-networking-sim.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm7-networking-sim.html');

describe('m7-networking-sim simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'controls', 'challenge', 'status', 'goal']));
  it('renders the topology, flow and DNS panels', () =>
    assertIds(html, ['topo', 'flows', 'dns-panel', 'dns-queries', 'resolv-conf']));
  it('teaches the packet-path policy transitions (DROPPED -> FORWARDED)', () =>
    assertTeaches(html, ['DROPPED', 'FORWARDED', 'default-deny', 'NetworkPolicy']));
  it('teaches the ndots DNS-resolution behaviour', () =>
    assertTeaches(html, ['ndots', 'resolv']));
});
