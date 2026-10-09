// Structural harness for m1-reconciliation.html
// Run: node --test site/static/sims/m1-reconciliation.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSim, assertWellFormed, assertSelfContained, assertIds, assertTeaches } from './_harness.mjs';

const html = readSim(import.meta.url, 'm1-reconciliation.html');

describe('m1-reconciliation simulator', () => {
  it('is well-formed HTML with balanced script tags', () => assertWellFormed(html));
  it('is self-contained (no external refs)', () => assertSelfContained(html));
  it('has the required interactive controls', () =>
    assertIds(html, ['app', 'reset', 'deploy', 'repPlus', 'repMinus', 'killBtn', 'cordonBtn', 'evList', 'challenge']));
  it('renders the observe/diff/act reconcile-loop phases', () =>
    assertIds(html, ['phObserve', 'phDiff', 'phAct', 'loop']));
  it('teaches the spec-vs-observed reconciliation model', () =>
    assertTeaches(html, ['Spec', 'Observe', 'Diff', 'cordon', 'reconcil']));
  it('respects prefers-reduced-motion', () => assertTeaches(html, ['prefers-reduced-motion']));
  it('lets learners browse challenge Steps 2 and 3 without advancing progress', () => {
    for (const step of [1, 2, 3]) {
      assert.match(html, new RegExp(`<button[^>]+id="d${step}"[^>]+data-step="${step}"[^>]+aria-label="Show Step ${step} instructions"`));
    }
    assert.match(html, /CH=\{step:1,\s*view:1,/);
    assert.match(html, /CH\.view=Number\(dot\.dataset\.step\)/);
    assert.match(html, /CH_TEXT\[CH\.view-1\]/);
  });
});
