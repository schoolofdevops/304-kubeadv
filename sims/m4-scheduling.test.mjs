#!/usr/bin/env node
// Headless-Chrome assertion harness for m4-scheduling.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m4-scheduling.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm4-scheduling.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9330 + (process.pid % 400);

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
    '--user-data-dir=/tmp/m4-sched-chrome-' + process.pid, 'about:blank',
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
  // run the sim's instant scheduler + read state
  async function scheduleAndRead() {
    await ev('window.__sched.schedule()');
    await sleep(80);
    return ev('(function(){var r=window.__sched.S.result||{};return {pending:!!r.pending,bound:r.bound||null,reason:r.reason||"",phase:window.__sched.S.phase};})()');
  }

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — nodes present', (await ev('document.querySelectorAll("#nodes .node").length')) === 4);
  ok('test hook exposed', (await ev('typeof window.__sched')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#schedBtn','#reset','#cpuUp','#cpuDown','#tolTog'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e)return;
      var cs=getComputedStyle(e);
      var hasCursor=/pointer|help/.test(cs.cursor);
      var hasTip=e.title||e.getAttribute('data-tip')||e.querySelector('[title]');
      if(!hasCursor)bad.push(s+':cursor='+cs.cursor);
    });
    // selector buttons + node cap buttons + taint chips
    document.querySelectorAll('#selRow button, .capedit button').forEach(function(e){
      if(getComputedStyle(e).cursor!=='pointer')bad.push('btn-cursor');
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const taintClickable = await ev(`getComputedStyle(document.querySelector('.chip.taint')).cursor`);
  ok('R2 taint chip is clickable (cursor:pointer)', taintClickable === 'pointer', taintClickable);
  const taintControls = await ev(`document.querySelectorAll('#nodes .chip.taint').length`);
  ok('R2 every node exposes an add/remove taint control', taintControls === 4, 'count=' + taintControls);
  await ev(`document.querySelector('[data-node="node-a"] .chip.taint').click()`);
  let nodeATaint = await ev(`(function(){var n=window.__sched.S.nodes.find(function(x){return x.id==='node-a'});return {taint:n.taint,on:n.taintOn}})()`);
  ok('learner can add the Step 3 taint to an untainted node', nodeATaint.taint === 'team=ml:NoSchedule' && nodeATaint.on === true, JSON.stringify(nodeATaint));
  await ev(`document.querySelector('[data-node="node-a"] .chip.taint').click()`);
  nodeATaint = await ev(`(function(){var n=window.__sched.S.nodes.find(function(x){return x.id==='node-a'});return {on:n.taintOn}})()`);
  ok('learner can remove the taint again', nodeATaint.on === false, JSON.stringify(nodeATaint));
  const challengeNav = await ev(`(function(){
    var dots=Array.from(document.querySelectorAll('#challenge .dot'));
    return dots.map(function(dot){return {
      cursor:getComputedStyle(dot).cursor,
      role:dot.getAttribute('role'),
      tabindex:dot.getAttribute('tabindex'),
      label:dot.getAttribute('aria-label')
    }});
  })()`);
  ok('R2 challenge steps expose pointer + keyboard affordance', challengeNav.every(function(dot){
    return dot.cursor==='pointer'&&dot.role==='button'&&dot.tabindex==='0'&&!!dot.label;
  }), JSON.stringify(challengeNav));

  // ---------- 2b. challenge instructions can be browsed directly ----------
  await ev(`document.getElementById('d2').click()`);
  let browsed = await ev(`({step:window.__sched.CH.step,view:window.__sched.CH.view,text:document.getElementById('chTxt').textContent})`);
  ok('challenge Step 2 is directly selectable without skipping progress', browsed.step === 1 && browsed.view === 2 && /Step 2/.test(browsed.text), JSON.stringify(browsed));
  await ev(`(function(){var e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true});document.getElementById('d3').dispatchEvent(e)})()`);
  browsed = await ev(`({step:window.__sched.CH.step,view:window.__sched.CH.view,text:document.getElementById('chTxt').textContent})`);
  ok('challenge Step 3 is keyboard selectable without skipping progress', browsed.step === 1 && browsed.view === 3 && /Step 3/.test(browsed.text), JSON.stringify(browsed));
  await ev(`document.getElementById('d1').click()`);

  // ---------- baseline: default spec binds ----------
  await ev('window.__sched.setCpu(500);window.__sched.setSelector("");window.__sched.setTolerate(false);window.__sched.setTaintAll(false)');
  // reset taints to original (only node-d tainted) via reload-free path: set all off then re-enable d
  await ev('window.__sched.S.nodes.forEach(function(n){n.taintOn=(n.id==="node-d")});window.__sched.setCpu(500)');
  let r = await scheduleAndRead();
  ok('baseline pod binds (not pending)', r.bound && !r.pending, JSON.stringify(r));

  // ---------- 3a. cause: insufficient cpu -> Pending ----------
  await ev('window.__sched.setCpu(4000)');
  r = await scheduleAndRead();
  ok('CAUSE cpu: all nodes filtered → Pending', r.pending === true, JSON.stringify(r));
  ok('CAUSE cpu: reason says Insufficient cpu', /Insufficient cpu/.test(r.reason), r.reason);
  ok('CAUSE cpu: reason mirrors "0/4 nodes are available"', /0\/4 nodes are available/.test(r.reason), r.reason);
  // adding capacity binds it
  await ev('window.__sched.setNodeCap("node-b", 8000)');
  r = await scheduleAndRead();
  ok('FIX cpu: raising node capacity → binds', r.bound === 'node-b' && !r.pending, JSON.stringify(r));

  // reset to baseline
  await ev('window.__sched.setNodeCap("node-b",4000);window.__sched.setCpu(500)');

  // ---------- 3b. cause: selector matches nothing -> Pending ----------
  await ev('window.__sched.setSelector("gpu=true")');
  r = await scheduleAndRead();
  ok('CAUSE selector: no node matches → Pending', r.pending === true, JSON.stringify(r));
  ok('CAUSE selector: reason mentions selector', /selector/.test(r.reason), r.reason);
  await ev('window.__sched.setSelector("disktype=ssd")');
  r = await scheduleAndRead();
  ok('FIX selector: a matching label → binds', !r.pending && r.bound, JSON.stringify(r));
  await ev('window.__sched.setSelector("")');

  // ---------- 3c. cause: untolerated taint on all nodes -> Pending, then tolerate binds ----------
  await ev('window.__sched.setTaintAll(true);window.__sched.setTolerate(false)');
  r = await scheduleAndRead();
  ok('CAUSE taint: all tainted, no toleration → Pending', r.pending === true, JSON.stringify(r));
  ok('CAUSE taint: reason mentions untolerated taint', /untolerated taint/.test(r.reason), r.reason);
  await ev('window.__sched.setTolerate(true)');
  r = await scheduleAndRead();
  ok('FIX taint: adding toleration → binds', !r.pending && r.bound, JSON.stringify(r));

  // ---------- 4. event log responds ----------
  const evCount = await ev('document.querySelectorAll("#evList .ev").length');
  ok('event log has entries', evCount > 5, 'count=' + evCount);
  const hasBind = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /→ node-|bind/i.test(e.textContent)})`);
  ok('event log shows a bind decision line', hasBind === true);
  const hasOut = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /OUT|FailedScheduling/.test(e.textContent)})`);
  ok('event log shows a filter-OUT / FailedScheduling line', hasOut === true);

  // ---------- 5. teaching invariant: score picks the most-free-CPU node ----------
  // Reset clean, two feasible nodes, more-free one must win.
  await ev(`(function(){var S=window.__sched.S;
    S.nodes.forEach(function(n){n.taintOn=(n.id==='node-d');n.taint=(n.id==='node-d')?'team=ml:NoSchedule':null});
    window.__sched.setSelector('');window.__sched.setTolerate(true);
    window.__sched.setNodeCap('node-a',2000); window.__sched.setNodeCap('node-b',4000); window.__sched.setNodeCap('node-c',2000);
    S.nodes.forEach(function(n){if(n.id==='node-a')n.used=800; if(n.id==='node-b')n.used=1000; if(n.id==='node-c')n.used=200;});
    window.__sched.setCpu(500);})()`);
  const comp = await ev('(function(){var c=window.__sched.compute();return {winner:c.winner,pending:!!c.pending};})()');
  // node-c: free=1800, node-a: free=1200, node-b free=3000 (biggest). node-b should win.
  ok('INVARIANT score: most-free-CPU node wins', comp.winner === 'node-b', JSON.stringify(comp));

  // ---------- 6. invariant: a status-only? no — invariant: fixing the reason flips pending→bound deterministically ----------
  // conservation: pending iff feasible set empty
  const consist = await ev(`(function(){var c=window.__sched.compute();
    var feasible=c.evals.filter(function(e){return e.feasible}).length;
    return (c.pending===(feasible===0));})()`);
  ok('INVARIANT: pending ⇔ zero feasible nodes', consist === true);

  // ---------- 7. challenge completes end-to-end via real controls ----------
  await ev('window.__sched.S.t0=Date.now()'); // no-op stabilizer
  // Step 1: raise cpu so all fail
  await ev(`(function(){var S=window.__sched.S;S.nodes.forEach(function(n){n.taintOn=false});
    window.__sched.setSelector('');window.__sched.setTolerate(false);
    ['node-a','node-b','node-c','node-d'].forEach(function(id){window.__sched.setNodeCap(id,2000)});
    window.__sched.setCpu(4000);})()`);
  await scheduleAndRead();
  let st = await ev('window.__sched.CH.step');
  ok('challenge step 1 auto-detected (cpu Pending)', st >= 2, 'step=' + st);
  // Step 2: selector nothing matches
  await ev('window.__sched.setCpu(500);window.__sched.setSelector("gpu=true")');
  await scheduleAndRead();
  st = await ev('window.__sched.CH.step');
  ok('challenge step 2 auto-detected (selector Pending)', st >= 3, 'step=' + st);
  // Step 3: use only visible controls to taint every node, then add the toleration.
  await ev(`(function(){
    window.__sched.setSelector('');window.__sched.setTaintAll(false);window.__sched.setTolerate(false);
    ['node-a','node-b','node-c','node-d'].forEach(function(id){
      document.querySelector('[data-node="'+id+'"] .chip.taint').click();
    });
  })()`);
  await scheduleAndRead();
  await ev(`document.getElementById('tolTog').click()`);
  r = await scheduleAndRead();
  const done = await ev('(function(){return {step:window.__sched.CH.step,success:document.getElementById("challenge").classList.contains("success")};})()');
  ok('challenge step 3 → binds with toleration', !r.pending && r.bound, JSON.stringify(r));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 8. no vertical scroll at 800x500 embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @800x500', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @800x500', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 9. prefers-reduced-motion suppresses animation ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const anim = await ev(`(function(){var e=document.querySelector('.ph-cell');var cs=getComputedStyle(e,null);
    return {t:cs.transitionDuration};})()`);
  // with reduce, our rule sets transition:none -> "0s"
  const reducedOK = await ev(`(function(){
    var bad=[];document.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad.push(el.className);
    });return bad.length;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedOK === 0, 'active=' + reducedOK);

  // ---------- 10. Reset control exists & reloads ----------
  ok('R5 reset control present', (await ev('!!document.getElementById("reset")')) === true);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m4-sched-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
