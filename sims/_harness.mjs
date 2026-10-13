// Shared structural assertions for the simulator .test.mjs harnesses.
// These are static checks (they read the HTML source, no browser) that guard the
// invariants every self-contained sim must hold: well-formed markup, zero external
// refs, the required interactive DOM, and the domain terms the sim is meant to teach.
// Sims that expose deeper runtime behaviour additionally ship a Chrome-CDP harness
// (see m4/m5/m6-*.test.mjs); this file backstops the ones that do not.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

export function readSim(importMetaUrl, htmlName) {
  const dir = path.dirname(fileURLToPath(importMetaUrl));
  return fs.readFileSync(path.join(dir, htmlName), 'utf8');
}

export function assertWellFormed(html) {
  assert.match(html, /<!doctype html>/i, 'must declare <!doctype html>');
  for (const tag of ['html', 'head', 'body']) {
    assert.match(html, new RegExp(`<${tag}[\\s>]`, 'i'), `missing <${tag}>`);
    assert.match(html, new RegExp(`</${tag}>`, 'i'), `missing </${tag}>`);
  }
  const open = (html.match(/<script\b[^>]*>/gi) || []).length;
  const close = (html.match(/<\/script>/gi) || []).length;
  assert.equal(open, close, `unbalanced <script> tags: ${open} open / ${close} close`);
  assert.ok(open >= 1, 'expected at least one inline <script>');
}

export function assertSelfContained(html) {
  const ext = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
  assert.equal(ext.length, 0, `must be self-contained; found external refs: ${ext.join(', ')}`);
}

export function assertIds(html, ids) {
  const missing = ids.filter(id => !new RegExp(`id=["']${id}["']`).test(html));
  assert.equal(missing.length, 0, `missing required element(s): #${missing.join(', #')}`);
}

export function assertTeaches(html, terms) {
  const missing = terms.filter(t => !html.includes(t));
  assert.equal(missing.length, 0, `sim no longer references: ${missing.join(', ')}`);
}
