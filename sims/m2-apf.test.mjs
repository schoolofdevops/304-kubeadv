// Structural harness for m2-apf.html
// Run: node --test site/static/sims/m2-apf.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm2-apf.html');

describe('m2-apf simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'rate', 'stormBtn', 'rolloutBtn', 'fsBtn', 'evList', 'challenge']));
  it('renders the APF metrics and flow lanes', () =>
    assertIds(html, ['metrics', 'mExec', 'mQ', 'mRej', 'lanes', 'apiserver']));
  it('exposes a test hook for runtime assertions', () =>
    assertTeaches(html, ['window.__apf']));
  it('teaches the FlowSchema / queue / reject (429) fairness model', () =>
    assertTeaches(html, ['FlowSchema', 'queue', 'reject', '429', 'shed']));
  it('respects prefers-reduced-motion', () => assertTeaches(html, ['prefers-reduced-motion']));
});
