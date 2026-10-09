#!/usr/bin/env node
// Headless-Chrome assertion harness for m5-operator.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m5-operator.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm5-operator.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9730 + (process.pid % 400);

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!CHROME) { console.error('No Chrome/Chromium found'); process.exit(2); }

let PASS = 0, FAIL = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; results.push('  PASS  ' + name); }
  else { FAIL++; results.push('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

// ---- minimal CDP over WebSocket (RFC6455 client, no deps) ----
function httpJSON(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve(b); }
      });
    });
    req.on('error', reject); req.end();
  });
}
function connectWS(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Origin: http://127.0.0.1:${PORT}\r\n\r\n`);
    });
    let handshaken = false; let buf = Buffer.alloc(0);
    const listeners = new Map(); let idc = 1; const evwaiters = [];
    function send(method, params = {}, sessionId) {
      const id = idc++; const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      sock.write(encodeFrame(JSON.stringify(msg)));
      return new Promise(res => listeners.set(id, res));
    }
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        handshaken = true; buf = buf.slice(idx + 4);
        resolve({ send, onEvent: (m, cb) => evwaiters.push({ m, cb }), close: () => sock.destroy() });
      }
      let f;
      while ((f = decodeFrame(buf))) {
        buf = f.rest;
        if (f.opcode === 8) { sock.destroy(); break; }
        if (f.opcode === 1 || f.opcode === 2) {
          let m; try { m = JSON.parse(f.payload.toString()); } catch { continue; }
          if (m.id && listeners.has(m.id)) { listeners.get(m.id)(m); listeners.delete(m.id); }
          if (m.method) evwaiters.filter(w => w.m === m.method).forEach(w => w.cb(m.params));
        }
      }
    });
    sock.on('error', reject);
  });
}
function encodeFrame(str) {
  const p = Buffer.from(str); const len = p.length;
  const mask = crypto.randomBytes(4); let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f; const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f; let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let mask; if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (masked) { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i & 3]; payload = o; }
  return { opcode, payload, rest: buf.slice(off + len) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    '--no-sandbox', '--disable-gpu', '--window-size=800,500',
    '--user-data-dir=/tmp/m5-op-chrome-' + process.pid, 'about:blank',
  ], { stdio: 'ignore' });

  // wait for devtools endpoint
  let version;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJSON('GET', '/json/version'); if (version && version.webSocketDebuggerUrl) break; } catch {}
    await sleep(150);
  }
  if (!version || !version.webSocketDebuggerUrl) { console.error('devtools endpoint never came up'); child.kill('SIGKILL'); process.exit(2); }

  // open a fresh tab for the file:// url (PUT for Chrome 150+)
  const tab = await httpJSON('PUT', '/json/new?' + encodeURIComponent(FILE_URL));
  const cdp = await connectWS(tab.webSocketDebuggerUrl);

  const consoleErrors = [], pageErrors = [], netRequests = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  cdp.onEvent('Runtime.consoleAPICalled', p => { if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args)); });
  cdp.onEvent('Runtime.exceptionThrown', p => pageErrors.push(p.exceptionDetails && p.exceptionDetails.text));
  cdp.onEvent('Network.requestWillBeSent', p => {
    const u = p.request.url;
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('about:')) netRequests.push(u);
  });

  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 800, height: 500, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: FILE_URL });
  await sleep(700);

  async function ev(expr) {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    if (r.result && r.result.result) return r.result.result.value;
    return undefined;
  }
  async function state() {
    return ev(`(function(){var S=window.__op.S;return {
      hasWebsite:!!S.website, replicas:S.website?S.website.replicas:null, host:S.website?S.website.host:null,
      terminating:S.terminating, deleting:S.deleting, running:S.op.running,
      pods:S.actual.pods.length, svcHost:S.actual.svcHost,
      status:S.status?S.status.ready:null
    };})()`);
  }

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('test hook exposed', (await ev('typeof window.__op')) === 'object');
  ok('renders — inert note visible at boot', (await ev('document.getElementById("inertNote").classList.contains("on")')) === true);

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#createBtn','#reset','#repUp','#repDown','#opToggle'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e)return;
      var cs=getComputedStyle(e);
      var hasCursor=/pointer|help/.test(cs.cursor);
      if(!hasCursor)bad.push(s+':cursor='+cs.cursor);
    });
    document.querySelectorAll('#hostRow button').forEach(function(e){
      if(getComputedStyle(e).cursor!=='pointer')bad.push('hostrow-cursor');
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertNoteCursor = await ev(`getComputedStyle(document.querySelector('#inertNote')).cursor`);
  ok('R2 inert note is visibly inert (cursor:default)', inertNoteCursor === 'default', inertNoteCursor);
  const deleteBtnDisabledAtBoot = await ev(`document.getElementById('deleteBtn').disabled`);
  ok('R2 delete button disabled before Website exists', deleteBtnDisabledAtBoot === true);

  // ---------- 3. KEY TEACHING POINT: create with operator Stopped → INERT ----------
  let s = await state();
  ok('boot: operator Stopped', s.running === false, JSON.stringify(s));
  ok('boot: no Website yet', s.hasWebsite === false, JSON.stringify(s));
  await ev('window.__op.createWebsite()');
  s = await state();
  ok('CAUSE inert: Website created while Stopped', s.hasWebsite === true, JSON.stringify(s));
  ok('CAUSE inert: zero pods exist (operator never ran)', s.pods === 0, JSON.stringify(s));
  ok('CAUSE inert: status subresource still empty', s.status === null, JSON.stringify(s));
  const inertNoteGoneCheck = await ev('document.getElementById("resWrap").style.display');
  ok('CAUSE inert: actual panel shows the Website frame but it stays empty', inertNoteGoneCheck === 'flex');
  const noPodsHint = await ev(`document.querySelector('#pods .empty-hint') ? document.querySelector('#pods .empty-hint').textContent : null`);
  ok('CAUSE inert: pods box shows "no pods"', noPodsHint === 'no pods', String(noPodsHint));

  // ---------- 4. start operator → converge on next tick ----------
  await ev('window.__op.setOperator(true)');
  await ev('window.__op.tick()');
  await sleep(50);
  s = await state();
  ok('FIX converge: starting operator creates pods to match desired replicas', s.pods === s.replicas && s.pods > 0, JSON.stringify(s));
  ok('FIX converge: status.ready reports N/N once converged', s.status === (s.replicas + '/' + s.replicas), JSON.stringify(s));
  ok('FIX converge: Service targets spec.host', s.svcHost === s.host, JSON.stringify(s));

  // ---------- 5. edit replicas while running → converges on next tick ----------
  await ev('window.__op.bumpReplicas(1)');
  let sMid = await state();
  ok('edit replicas: desired bumped by 1 before tick', sMid.replicas === s.replicas + 1, JSON.stringify(sMid));
  await ev('window.__op.tick()');
  await sleep(50);
  s = await state();
  ok('CONVERGE: pod count catches up to new desired replicas', s.pods === s.replicas, JSON.stringify(s));

  // ---------- 6. CEL guardrail: replicas may not exceed 5 ----------
  const beforeReplicas = s.replicas;
  await ev('window.__op.bumpReplicas(1)'); // to 4 (assuming baseline 2->3, now 3->4 depending path); ensure headroom then push over
  s = await state();
  // push replicas to the boundary and beyond deterministically
  await ev('window.__op.setReplicasRaw(5)');
  let celState = await ev('document.getElementById("celWarn").classList.contains("on")');
  ok('CEL: replicas=5 (at the limit) is accepted, no warning', celState === false, String(celState));
  await ev('window.__op.setReplicasRaw(6)');
  celState = await ev('document.getElementById("celWarn").classList.contains("on")');
  const celMsg = await ev('document.getElementById("celWarn").textContent');
  ok('CEL: replicas=6 rejected — warning shown', celState === true, String(celState));
  ok('CEL: rejection message says "replicas may not exceed 5"', /replicas may not exceed 5/.test(celMsg), celMsg);
  s = await state();
  ok('CEL: rejected value did NOT mutate spec.replicas', s.replicas === 5, JSON.stringify(s));
  await ev('window.__op.tick()'); await sleep(50);
  s = await state();
  ok('CEL: actual pods still track the last VALID desired (5), not the rejected 6', s.pods === 5, JSON.stringify(s));

  // ---------- 7. self-heal: delete a pod while Running → recreated next tick ----------
  let podId = await ev(`window.__op.S.actual.pods[0].id`);
  await ev(`window.__op.deletePod('${podId}')`);
  s = await state();
  ok('DRIFT-heal setup: pod removed immediately', s.pods === 4, JSON.stringify(s));
  await ev('window.__op.tick()');
  await sleep(50);
  s = await state();
  ok('SELF-HEAL: deleted pod recreated on next tick while Running', s.pods === 5, JSON.stringify(s));
  const healSeen = await ev('window.__op.CH.healSeen');
  ok('SELF-HEAL: challenge tracker recorded the heal event', healSeen === true);

  // ---------- 8. drift: stop operator, delete a pod → stays gone ----------
  await ev('window.__op.setOperator(false)');
  podId = await ev(`window.__op.S.actual.pods[0].id`);
  await ev(`window.__op.deletePod('${podId}')`);
  s = await state();
  ok('DRIFT: pod deleted while Stopped', s.pods === 4, JSON.stringify(s));
  // give it time — with operator stopped no interval should fire and change pod count
  await sleep(300);
  s = await state();
  ok('DRIFT: pod count stays at 4 — operator Stopped means no reconcile', s.pods === 4, JSON.stringify(s));
  const driftSeen = await ev('window.__op.CH.driftSeen');
  ok('DRIFT: challenge tracker recorded the drift event', driftSeen === true);

  // ---------- 9. restart operator → re-converges (self-heals the drifted pod) ----------
  await ev('window.__op.setOperator(true)');
  await ev('window.__op.tick()');
  await sleep(50);
  s = await state();
  ok('RE-CONVERGE: restarting operator heals drift back to desired replicas', s.pods === 5, JSON.stringify(s));

  // ---------- 10. finalizer: delete Website while Stopped → stuck Terminating ----------
  await ev('window.__op.setOperator(false)');
  await ev('window.__op.deleteWebsite()');
  s = await state();
  ok('FINALIZER-block: delete while Stopped sets terminating', s.terminating === true, JSON.stringify(s));
  ok('FINALIZER-block: Website still exists (not removed)', s.hasWebsite === true, JSON.stringify(s));
  const termBadgeOn = await ev('document.getElementById("termBadge").classList.contains("on")');
  ok('FINALIZER-block: Terminating badge visible', termBadgeOn === true);
  await sleep(250);
  s = await state();
  ok('FINALIZER-block: stays stuck with operator Stopped (no progress)', s.hasWebsite === true && s.terminating === true, JSON.stringify(s));

  // ---------- 11. finalizer completes + ownerReference GC when operator restarts ----------
  // setOperator(true) fires one immediate tick itself (instant feedback, same as
  // starting the loop) — that first tick is the cleanup tick, so no extra tick() needed here.
  await ev('window.__op.setOperator(true)');
  await sleep(30);
  s = await state();
  ok('FINALIZE-step1: children torn down first (ownerRef GC)', s.pods === 0 && s.svcHost === null, JSON.stringify(s));
  ok('FINALIZE-step1: Website not yet removed (still finalizing)', s.hasWebsite === true, JSON.stringify(s));
  await ev('window.__op.tick()'); await sleep(30); // next tick: finalizer removed, Website gone
  s = await state();
  ok('FINALIZE-step2: Website fully deleted once children are gone', s.hasWebsite === false, JSON.stringify(s));
  ok('FINALIZE-step2: status cleared with the Website', s.status === null, JSON.stringify(s));
  const inertNoteBack = await ev('document.getElementById("inertNote").classList.contains("on")');
  ok('FINALIZE-step2: inert note returns — nothing desired, nothing actual', inertNoteBack === true);

  // ---------- 12. finalizer while Running: delete → children cleaned then Website removed ----------
  await ev('window.__op.tryCreateWithReplicas(2)');
  await ev('window.__op.tick()'); await sleep(30);
  s = await state();
  ok('re-create + converge for running-delete test', s.pods === 2, JSON.stringify(s));
  await ev('window.__op.deleteWebsite()'); // operator is Running here
  s = await state();
  ok('RUNNING-delete: finalizer path started immediately (deleting=true)', s.deleting === true, JSON.stringify(s));
  // deleteWebsite() runs one immediate tick internally when running; children should be gone already or on first tick
  await ev('window.__op.tick()'); await sleep(30);
  s = await state();
  ok('RUNNING-delete: Website fully removed after finalizer runs while operator stayed Running', s.hasWebsite === false, JSON.stringify(s));

  // ---------- 13. ownerReference badge present on children ----------
  await ev('window.__op.tryCreateWithReplicas(2)');
  await ev('window.__op.setOperator(true)'); // already true, harmless
  await ev('window.__op.tick()'); await sleep(30);
  const ownerBadge = await ev(`document.querySelector('#deployBox .owner') ? document.querySelector('#deployBox .owner').textContent : null`);
  ok('ownerReference badge visible on Deployment child', /owned by my-site/.test(ownerBadge || ''), String(ownerBadge));

  // ---------- 14. event log responds ----------
  const evCount = await ev('document.querySelectorAll("#evList .ev").length');
  ok('event log has entries', evCount > 5, 'count=' + evCount);
  const hasReconcile = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /reconcile|scaled up/i.test(e.textContent)})`);
  ok('event log shows a reconcile line', hasReconcile === true);
  const hasFinalize = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /finaliz/i.test(e.textContent)})`);
  ok('event log shows a finalize line', hasFinalize === true);
  const hasDrift = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /drift/i.test(e.textContent)})`);
  ok('event log shows a drift line', hasDrift === true);

  // ---------- 15. challenge completes end-to-end via real controls (fresh sequence) ----------
  await ev('location.reload()');
  await sleep(600);
  await ev('window.__op.setOperator(false)');
  await ev('window.__op.createWebsite()');
  await sleep(30);
  let st = await ev('window.__op.CH.step');
  ok('challenge step 1 auto-detected (created while Stopped → inert)', st >= 2, 'step=' + st);
  await ev('window.__op.setOperator(true)');
  await ev('window.__op.tick()');
  await sleep(60);
  st = await ev('window.__op.CH.step');
  ok('challenge step 2 auto-detected (converged, status Ready N/N)', st >= 3, 'step=' + st);
  await ev('window.__op.setOperator(false)');
  let pid2 = await ev(`window.__op.S.actual.pods[0].id`);
  await ev(`window.__op.deletePod('${pid2}')`);
  await sleep(30);
  await ev('window.__op.setOperator(true)');
  await ev('window.__op.tick()');
  await sleep(60);
  const done = await ev('(function(){return {step:window.__op.CH.step,success:document.getElementById("challenge").classList.contains("success")};})()');
  ok('challenge step 3 completes (drift then self-heal)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 16. no overflow scroll at 800x500 embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @800x500', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @800x500', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 17. prefers-reduced-motion suppresses animation ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedOK = await ev(`(function(){
    var bad=[];document.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad.push(el.className);
    });return bad.length;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedOK === 0, 'active=' + reducedOK);

  // ---------- 18. Reset control exists ----------
  ok('R5 reset control present', (await ev('!!document.getElementById("reset")')) === true);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m5-op-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
