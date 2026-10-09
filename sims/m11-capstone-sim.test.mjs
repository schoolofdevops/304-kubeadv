// Structural harness for m11-capstone-sim.html
// Run: node --test site/static/sims/m11-capstone-sim.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm11-capstone-sim.html');

describe('m11-capstone-sim simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'controls', 'challenge', 'goal', 'dots']));
  it('teaches the war-room multi-fault triage model', () =>
    assertTeaches(html, ['fault', 'fix']));
  it('spans the platform-wide failure domains (etcd, DNS, Kueue, operator)', () =>
    assertTeaches(html, ['etcd', 'DNS', 'Kueue', 'operator']));
});
