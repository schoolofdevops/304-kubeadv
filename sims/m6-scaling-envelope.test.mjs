#!/usr/bin/env node
// Headless-Chrome assertion harness for m6-scaling-envelope.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m6-scaling-envelope.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm6-scaling-envelope.html');
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
    '--no-sandbox', '--disable-gpu', '--window-size=900,560',
    '--user-data-dir=/tmp/m6-scale-chrome-' + process.pid, 'about:blank',
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
    { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
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
    return ev(`(function(){var S=window.__scale.S;var M=window.__scale;var pods=M.totalPods();return {
      nodes:S.nodes, podsPerNode:S.podsPerNode, watchClients:S.watchClients, listQps:S.listQps, useWatch:S.useWatch,
      pods:pods, latency:M.listLatencySeconds(pods), payload:M.payloadMB(pods),
      p99:M.apiServerP99Ms(), apf:M.apfSaturationPct(), etcd:M.etcdCounts(pods)
    };})()`);
  }

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('test hook exposed', (await ev('typeof window.__scale')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#watchToggle','#sc1','#sc2','#sc3'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      var hasCursor=/pointer|help/.test(cs.cursor);
      if(!hasCursor)bad.push(s+':cursor='+cs.cursor);
    });
    document.querySelectorAll('input[type=range]').forEach(function(e){
      if(getComputedStyle(e).cursor!=='pointer')bad.push('range-cursor:'+e.id);
    });
    document.querySelectorAll('.gauge').forEach(function(e){
      if(getComputedStyle(e).cursor!=='help')bad.push('gauge-cursor:'+e.id);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertCurve = await ev(`getComputedStyle(document.querySelector('#curveBox')).cursor`);
  ok('R2 curve box is visibly inert (cursor:default)', inertCurve === 'default', inertCurve);
  const inertAnno = await ev(`getComputedStyle(document.querySelector('#eventsAnno')).cursor`);
  ok('R2 events annotation is visibly inert (cursor:default)', inertAnno === 'default', inertAnno);

  // ---------- 3. boot state: dials at zero, gauges near-zero ----------
  let s = await state();
  ok('boot: nodes=0', s.nodes === 0, JSON.stringify(s));
  ok('boot: pods=0', s.pods === 0, JSON.stringify(s));
  ok('boot: useWatch=false', s.useWatch === false, JSON.stringify(s));
  ok('boot: latency at floor (~0.08s)', Math.abs(s.latency - 0.08) < 0.01, JSON.stringify(s));

  // ---------- 4. KEY TEACHING POINT: grow pods toward the knee — latency/payload climb ----------
  await ev('window.__scale.setNodes(1000)');
  await ev('window.__scale.setPodsPerNode(11)'); // ~11,000 pods — matches live spike anchor
  s = await state();
  ok('KNEE: total pods ≈ 11,000 (spike anchor)', s.pods >= 10500 && s.pods <= 11500, JSON.stringify(s));
  ok('KNEE: full-list latency crossed ~5s at this pod count', s.latency >= 4.5, JSON.stringify(s));
  ok('KNEE: payload ≈ 68MB at ~11k pods (spike anchor: 68.1MB @ 10,981)', s.payload >= 55 && s.payload <= 80, JSON.stringify(s));

  // monotonic growth check: latency and payload increase with pods (0 -> 1k -> 5k -> 10k)
  const growth = await ev(`(function(){var M=window.__scale;
    var l0=M.listLatencySeconds(0), l1=M.listLatencySeconds(1000), l5=M.listLatencySeconds(5000), l10=M.listLatencySeconds(10000);
    var p0=M.payloadMB(0), p10=M.payloadMB(10000);
    return {l0:l0,l1:l1,l5:l5,l10:l10,p0:p0,p10:p10,
      monotonic: l0<l1 && l1<l5 && l5<l10,
      payloadMonotonic: p0<p10};
  })()`);
  ok('GROWTH: latency is monotonically increasing with pod count', growth.monotonic === true, JSON.stringify(growth));
  ok('GROWTH: payload is monotonically increasing with pod count', growth.payloadMonotonic === true, JSON.stringify(growth));
  ok('ANCHOR: latency@1000 ≈ 0.53s (live spike)', Math.abs(growth.l1 - 0.53) < 0.05, JSON.stringify(growth));
  ok('ANCHOR: latency@5000 ≈ 2.22s (live spike)', Math.abs(growth.l5 - 2.22) < 0.1, JSON.stringify(growth));
  ok('ANCHOR: latency@10000 ≈ 4.85s (live spike)', Math.abs(growth.l10 - 4.85) < 0.1, JSON.stringify(growth));

  // ---------- 5. THE CONTRAST: apiserver p99 stays flat while client latency climbs ----------
  const p99AtZero = await ev('window.__scale.apiServerP99Ms()'); // list QPS still 0 here
  s = await state();
  ok('CONTRAST: apiserver p99 stays low/flat at ~11k pods (server is fine)', s.p99 <= 30, JSON.stringify(s));
  ok('CONTRAST: p99 unaffected by pod count alone (only list QPS moves it)', p99AtZero === s.p99, JSON.stringify({p99AtZero, sp99: s.p99}));
  const p99Gauge = await ev(`document.getElementById('gApiP99').classList.contains('healthy')`);
  ok('CONTRAST: apiserver gauge shows healthy styling while client gauges show knee', p99Gauge === true);
  const listGaugeKnee = await ev(`document.getElementById('gListLatency').classList.contains('knee')`);
  ok('CONTRAST: full-list latency gauge shows knee styling at ~11k pods', listGaugeKnee === true);

  // ---------- 6. events > pods annotation fires (OpenAI lesson) ----------
  s = await state();
  ok('EVENTS: events count exceeds pods count at this scale', s.etcd.events > s.etcd.pods, JSON.stringify(s.etcd));
  const annoOn = await ev(`document.getElementById('eventsAnno').classList.contains('on')`);
  ok('EVENTS: events>pods annotation banner is visible', annoOn === true);
  const annoText = await ev(`document.getElementById('eventsAnno').textContent`);
  ok('EVENTS: annotation mentions separate etcd (OpenAI lesson)', /separate etcd/i.test(annoText), annoText);

  // ---------- 7. APF saturation: crank list QPS past the threshold ----------
  await ev('window.__scale.setListQps(0)');
  s = await state();
  ok('APF: near zero at listQps=0', s.apf < 20, JSON.stringify(s));
  const apfBadgeOffAtZero = await ev(`document.getElementById('apfBadge').classList.contains('on')`);
  ok('APF: saturation badge off at listQps=0', apfBadgeOffAtZero === false);

  await ev('window.__scale.setListQps(48)');
  s = await state();
  ok('APF: saturation value is at/above the 70% threshold at listQps=48', s.apf >= 70, JSON.stringify(s));
  const apfBadgeOn = await ev(`document.getElementById('apfBadge').classList.contains('on')`);
  ok('APF: saturation badge visible past threshold', apfBadgeOn === true);
  const apfBadgeText = await ev(`document.getElementById('apfBadge').textContent`);
  ok('APF: badge mentions queued/rejected', /queued|rejected/i.test(apfBadgeText), apfBadgeText);

  // p99 should rise now too, since APF saturation is a server-side concurrency problem
  const p99Sat = await ev('window.__scale.apiServerP99Ms()');
  ok('APF: server-side p99 rises once APF is saturated (a real server cost)', p99Sat > 16, 'p99=' + p99Sat);

  // ---------- 8. WATCH toggle collapses list cost (the mitigation) ----------
  await ev('window.__scale.setListQps(0)'); // isolate the watch-collapse effect from APF
  s = await state();
  const latencyBeforeWatch = s.latency;
  ok('pre-WATCH: latency still elevated at ~11k pods', latencyBeforeWatch >= 4, JSON.stringify(s));
  await ev('window.__scale.setUseWatch(true)');
  s = await state();
  ok('WATCH toggle: state flag flipped', s.useWatch === true, JSON.stringify(s));
  const listGaugeCollapsed = await ev(`document.getElementById('gListLatency').classList.contains('collapsed')`);
  const payloadGaugeCollapsed = await ev(`document.getElementById('gPayload').classList.contains('collapsed')`);
  ok('WATCH: full-list latency gauge visually collapses', listGaugeCollapsed === true);
  ok('WATCH: payload gauge visually collapses', payloadGaugeCollapsed === true);
  const listGaugeText = await ev(`document.getElementById('vListLatency').textContent`);
  const payloadGaugeText = await ev(`document.getElementById('vPayload').textContent`);
  ok('WATCH: latency gauge now reads O(changes), not seconds', /O\(changes\)/.test(listGaugeText), listGaugeText);
  ok('WATCH: payload gauge now reads diff-only, not MB total', /diff/i.test(payloadGaugeText), payloadGaugeText);
  const noLongerKnee = await ev(`document.getElementById('gListLatency').classList.contains('knee')`);
  ok('WATCH: knee styling cleared once collapsed', noLongerKnee === false);

  // flip back — should return to the O(objects) cost
  await ev('window.__scale.setUseWatch(false)');
  s = await state();
  ok('WATCH OFF: reverts to O(objects) cost (latency elevated again)', s.latency >= 4, JSON.stringify(s));

  // ---------- 9. scenario buttons drive state as documented ----------
  await ev('location.reload()');
  await sleep(600);
  await ev('window.__scale.applyScenario(1)');
  s = await state();
  ok('SCENARIO 1: loads ~11k pods (kwok-scale spike shape)', s.pods >= 10000 && s.pods <= 12000, JSON.stringify(s));
  await ev('window.__scale.applyScenario(2)');
  s = await state();
  ok('SCENARIO 2: cranks list QPS toward saturation', s.listQps >= 40, JSON.stringify(s));
  ok('SCENARIO 2: APF saturation now past threshold', s.apf >= 70, JSON.stringify(s));
  await ev('window.__scale.applyScenario(3)');
  s = await state();
  ok('SCENARIO 3: flips to WATCH', s.useWatch === true, JSON.stringify(s));

  // ---------- 10. TRY-THIS challenge completes end-to-end via real controls (fresh sequence) ----------
  await ev('location.reload()');
  await sleep(600);
  let st = await ev('window.__scale.CH.step');
  ok('challenge starts at step 1', st === 1, 'step=' + st);
  await ev('window.__scale.setNodes(1000)');
  await ev('window.__scale.setPodsPerNode(11)');
  await sleep(30);
  st = await ev('window.__scale.CH.step');
  ok('challenge step 1 auto-detected (knee reached, p99 flat)', st >= 2, 'step=' + st);
  await ev('window.__scale.setListQps(48)');
  await sleep(30);
  st = await ev('window.__scale.CH.step');
  ok('challenge step 2 auto-detected (APF saturated)', st >= 3, 'step=' + st);
  await ev('window.__scale.setListQps(0)');
  await ev('window.__scale.setUseWatch(true)');
  await sleep(30);
  const done = await ev('(function(){return {step:window.__scale.CH.step,success:document.getElementById("challenge").classList.contains("success")};})()');
  ok('challenge step 3 completes (WATCH collapses cost)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 11. event log responds ----------
  const evCount = await ev('document.querySelectorAll("#evList .ev").length');
  ok('event log has entries', evCount > 5, 'count=' + evCount);
  const hasDialLine = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /dial/i.test(e.textContent)})`);
  ok('event log shows dial-change lines', hasDialLine === true);
  const hasMitigationLine = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /mitigation|WATCH/i.test(e.textContent)})`);
  ok('event log shows a WATCH mitigation line', hasMitigationLine === true);
  const hasEtcdLine = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /etcd/i.test(e.textContent)})`);
  ok('event log shows an etcd events>pods line', hasEtcdLine === true);

  // ---------- 12. no overflow scroll at 900x560 embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @900x560', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @900x560', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 13. prefers-reduced-motion suppresses animation ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedOK = await ev(`(function(){
    var bad=[];document.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad.push(el.className);
    });return bad.length;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedOK === 0, 'active=' + reducedOK);

  // ---------- 14. Reset control exists ----------
  ok('R5 reset control present', (await ev('!!document.getElementById("reset")')) === true);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m6-scale-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
