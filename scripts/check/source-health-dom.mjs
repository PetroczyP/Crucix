#!/usr/bin/env node
// Source-health grid visibility check (issue 006, AC-6).
//
// What it proves: a source that FAILED renders as failed, rather than silently vanishing.
// Before 006, `srcHtml` was built at jarvis.html:1714 and never inserted into the DOM, so
// there was no per-source failure indicator at all — the dashboard simply showed one fewer
// dot. Counting rows is therefore not enough: this also asserts the rows are VISIBLE, since
// 29 correctly-classed items inside a display:none wrapper would satisfy every count and
// class assertion while showing the operator nothing.
//
// Route: an in-process fixture server serves the real jarvis.html plus a crafted /api/data.
// jarvis.html fetches /api/data on load and calls init(), so this drives the genuine render
// path. It deliberately does NOT import server.mjs — that would construct alerters, read
// .env, start a 29-source sweep and rewrite runs/. Containment here is a property of what
// this script does not do, not something it has to protect. The timing -> V2.health half of
// the pipeline is proven separately and deterministically by test/dashboard-health.test.mjs.
//
// Lives under scripts/, NOT test/: `npm test` is `node --test`, which would try to run this
// as a unit test (same reason as scripts/perf/globe-frame-time.mjs).
//
//   npm run check:source-health
//
// Requires Chrome with remote debugging. Exits non-zero on any failure, never on "looks fine".
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_PORT = process.env.CDP_PORT || 9222;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_TIMEOUT = 25000;

const SOURCES = ['GDELT','OpenSky','FIRMS','Maritime','Safecast','ACLED','ReliefWeb','WHO','OFAC',
  'OpenSanctions','ADS-B','FRED','Treasury','BLS','EIA','GSCPI','USAspending','Comtrade','NOAA','EPA',
  'Patents','Bluesky','Reddit','Telegram','KiwiSDR','Space','YFinance','CISA-KEV','Cloudflare-Radar'];
// Pinned by exact name, not "any three": if a real sweep or a stale payload replaced the
// fixture, these specific rows would not carry these specific states and the check fails.
const FAILED = ['EPA', 'FRED', 'Space'];
const HEALTHY_ROW = 'GDELT';

// The served payload is built by the REAL synthesize(), from a briefing-shaped fixture
// whose `timing` carries the failure states. Hand-shaping ~30 V2 fields invites a payload
// the page cannot render (measured: `air: {}` where an array is expected throws inside
// renderLeftRail), which would make this check fail for a reason unrelated to what it tests.
const briefingFixture = (failed) => ({
  crucix: { version: '2.0.0', timestamp: new Date().toISOString(), totalDurationMs: 1000,
            sourcesQueried: SOURCES.length, sourcesOk: SOURCES.length - failed.length,
            sourcesFailed: failed.length },
  sources: Object.fromEntries(SOURCES.map(n => [n, failed.includes(n) ? { error: `${n} failed` } : {}])),
  errors: failed.map(n => ({ name: n, error: `${n} failed` })),
  timing: Object.fromEntries(SOURCES.map(n => [n, { status: failed.includes(n) ? 'error' : 'ok', ms: 10 }])),
});

const { synthesize } = await import('../../dashboard/inject.mjs');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('<rss><channel></channel></rss>', { status: 200 });
const V2 = await synthesize(briefingFixture(FAILED));
globalThis.fetch = realFetch;   // CDP needs the real fetch back

// ---- fixture server -------------------------------------------------------
let health = V2.health;
const page = readFileSync(join(ROOT, 'dashboard', 'public', 'jarvis.html'), 'utf8');
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/data')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...V2, health }));
  }
  if (req.url.startsWith('/events')) {           // hold it open; never push
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.write(': open\n\n');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const TARGET = `http://127.0.0.1:${server.address().port}`;

// ---- CDP ------------------------------------------------------------------
async function cdp() {
  let list;
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); if (list.length) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!list || !list.length) throw new Error(`no Chrome on CDP port ${CDP_PORT}. Start it with:\n` +
    `  chrome --headless=new --remote-debugging-port=${CDP_PORT} --user-data-dir=/tmp/cdp about:blank &`);
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const pageErrors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error('CDP error: ' + JSON.stringify(m.error))) : res(m); }
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      pageErrors.push(m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 140));
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      const detail = d.exception?.description || d.exception?.value || d.text || '';
      pageErrors.push('exception: ' + String(detail).slice(0, 300));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP timeout: ' + method)); } }, EVAL_TIMEOUT);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, pageErrors, close: () => ws.close() };
}
const ev = async (send, expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('page exception: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 200));
  return r.result?.result?.value;
};

const POLL = `new Promise(res=>{const t0=Date.now();(function tick(){
  const n=document.querySelectorAll('#lowerGrid .src-item').length;
  if(n>0||Date.now()-t0>10000) res(n); else setTimeout(tick,150);})()})`;

const ASSERT = `(() => {
  const grid = document.querySelector('#lowerGrid .src-grid');
  const items = grid ? [...grid.querySelectorAll(':scope > .src-item')] : [];
  const row = (name) => items.find(el => (el.querySelector('span')?.textContent||'').trim() === name);
  const state = (el) => { if (!el) return null;
    const dot = el.querySelector('.sd'); const r = dot.getBoundingClientRect();
    const cs = getComputedStyle(dot);
    return { cls: [...dot.classList].filter(c => c !== 'sd'),
             w: r.width, h: r.height, display: cs.display, visibility: cs.visibility }; };
  const de = document.documentElement;
  return JSON.stringify({ gridExists: !!grid, count: items.length,
    failed: state(row(${JSON.stringify(FAILED[0])})), healthy: state(row(${JSON.stringify(HEALTHY_ROW)})),
    names: items.map(el => (el.querySelector('span')?.textContent||'').trim()),
    overflow: de.scrollWidth - de.clientWidth });
})()`;

const failures = [];
const must = (c, m) => { if (!c) failures.push(m); };

const { send, pageErrors, close } = await cdp();
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  for (const [label, w, h, mobile] of [['desktop', 1440, 900, false], ['narrow', 390, 844, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: TARGET });
    const n = await ev(send, POLL);
    must(n > 0, `${label}: no .src-item ever rendered (got ${n}) — is srcHtml wired into #lowerGrid?`);
    const r = JSON.parse(await ev(send, ASSERT) || '{}');

    must(r.gridExists, `${label}: #lowerGrid .src-grid missing`);
    must(r.count === SOURCES.length, `${label}: expected ${SOURCES.length} rows, got ${r.count}`);
    // fixture identity — these exact rows in these exact states
    must(r.failed?.cls.includes('err'), `${label}: ${FAILED[0]} should carry .sd.err, got ${r.failed?.cls}`);
    must(r.healthy?.cls.includes('ok'), `${label}: ${HEALTHY_ROW} should carry .sd.ok, got ${r.healthy?.cls}`);
    must(FAILED.every(f => r.names?.includes(f)), `${label}: fixture rows missing — got ${r.names?.length} names`);
    // visibility, not just presence
    for (const [which, s] of [['failed', r.failed], ['healthy', r.healthy]]) {
      must(s && s.w > 0 && s.h > 0, `${label}: ${which} dot has zero bounding box (${s?.w}x${s?.h})`);
      must(s && s.display !== 'none', `${label}: ${which} dot display:${s?.display}`);
      must(s && s.visibility !== 'hidden', `${label}: ${which} dot visibility:${s?.visibility}`);
    }
    must(r.overflow <= 1, `${label}: document overflows horizontally by ${r.overflow}px`);
  }

  // BREAK case: an empty health array must render without throwing.
  const before = pageErrors.length;
  await ev(send, `(() => { D.health = []; reinit(); return 'ok'; })()`);
  const empty = JSON.parse(await ev(send, ASSERT) || '{}');
  must(empty.count === 0, `empty health should render 0 rows, got ${empty.count}`);
  must(pageErrors.length === before, `empty health threw: ${pageErrors.slice(before).join(' | ')}`);

  must(pageErrors.length === 0, `console errors: ${pageErrors.join(' | ')}`);
} finally {
  close();
  // The page holds /events open, so server.close() alone would wait forever for it.
  server.closeAllConnections();
  server.close();
}

if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log(`PASS — ${SOURCES.length} source rows rendered and visible at both viewports; ` +
            `${FAILED.join(', ')} shown failed, ${HEALTHY_ROW} shown healthy; empty health safe.`);
