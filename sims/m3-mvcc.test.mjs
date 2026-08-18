// Structural harness for m3-mvcc.html
// Run: node --test site/static/sims/m3-mvcc.test.mjs
import { describe, it } from 'node:test';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm3-mvcc.html');

describe('m3-mvcc simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'burstBtn', 'compactBtn', 'defragBtn', 'readBtn', 'evList', 'challenge']));
  it('renders the ledger, store grid and metrics', () =>
    assertIds(html, ['ledger', 'storeGrid', 'metrics', 'metRev', 'metPhys', 'metUse', 'alarmBar']));
  it('exposes a test hook for runtime assertions', () =>
    assertTeaches(html, ['window.__mvcc']));
  it('teaches the revision / compact / defrag / quota storage model', () =>
    assertTeaches(html, ['revision', 'compact', 'defrag', 'quota', 'NOSPACE', 'tombstone']));
  it('respects prefers-reduced-motion', () => assertTeaches(html, ['prefers-reduced-motion']));
});
