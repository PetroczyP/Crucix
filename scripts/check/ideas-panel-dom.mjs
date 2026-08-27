#!/usr/bin/env node
// Ideas-panel source badge + empty-state check (issue 013, AC-6).
//
// What it proves: the ideas panel gained a 'rules' source, and the dashboard tells the truth
// in both languages. Before 013, `jarvis.html` had only three badge arms — 'llm', 'disabled',
// and a catch-all 'PENDING' — and a single hardcoded empty-state string, "LLM NOT CONFIGURED",
// shown whenever `D.ideas` was empty regardless of why. Under the revised thresholds 59.6% of
// real sweeps produce zero rule ideas, so that message would be false on the majority of runs:
// a working rule engine that simply found no signal would look exactly like a disabled LLM.
// Counting a badge element existing is not enough — a build that renders the badge in English
// only, or renders "LLM NOT CONFIGURED" beside a 'rules' source, satisfies "a badge is there"
// while failing the actual claim. This asserts the rendered TEXT against the locale FILE, read
// at runtime, in both en and fr, for all four ideasSource states, plus visibility of the
// empty-state element (a correct element inside a display:none wrapper would otherwise pass).
//
// Route: an in-process fixture server serves the real jarvis.html (with a server.mjs:249-style
// locale injection ahead of the inline script, since server.mjs never runs here) plus a crafted
// /api/data built by the REAL synthesize(), same technique as scripts/check/source-health-dom.mjs.
// It deliberately does NOT import server.mjs, read .env, start a sweep, or write runs/ — the
// pipeline that turns a briefing into V2 is exercised by synthesize() alone; `D.ideasSource` and
// `D.ideas` are then mutated in-page and `renderLower()` is re-invoked, the same BREAK-case
// pattern source-health-dom.mjs uses for its empty-health case, to drive all four badge states
// and both empty/non-empty ideas states without needing four separate real rule outcomes.
//
// Lives under scripts/, NOT test/: `npm test` is `node --test`, which would try to run this as
// a unit test (same reason as scripts/perf/globe-frame-time.mjs and source-health-dom.mjs).
//
//   npm run check:ideas-panel
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

// The served /api/data payload is built by the REAL synthesize(), from a briefing-shaped fixture
// with every source healthy — AC-6 is a rendering question, not a source-health one, and hand-
// shaping ~30 V2 fields invites a payload the page cannot render for reasons unrelated to what
// this checks (see source-health-dom.mjs for the measured example: `air: {}` throws inside
// renderLeftRail). `ideasSource`/`ideas` are overwritten per-scenario after this base render.
const briefingFixture = () => ({
  crucix: { version: '2.0.0', timestamp: new Date().toISOString(), totalDurationMs: 1000,
            sourcesQueried: SOURCES.length, sourcesOk: SOURCES.length, sourcesFailed: 0 },
  sources: Object.fromEntries(SOURCES.map(n => [n, {}])),
  errors: [],
  timing: Object.fromEntries(SOURCES.map(n => [n, { status: 'ok', ms: 10 }])),
});

const { synthesize } = await import('../../dashboard/inject.mjs');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('<rss><channel></channel></rss>', { status: 200 });
const V2 = await synthesize(briefingFixture());
globalThis.fetch = realFetch;   // CDP needs the real fetch back

// ---- locale files, read at runtime — never a hardcoded English string ---------------------
const LOCALES = {
  en: JSON.parse(readFileSync(join(ROOT, 'locales', 'en.json'), 'utf8')),
  fr: JSON.parse(readFileSync(join(ROOT, 'locales', 'fr.json'), 'utf8')),
};

// ---- fixture server -------------------------------------------------------
const page = readFileSync(join(ROOT, 'dashboard', 'public', 'jarvis.html'), 'utf8');
let currentLocale = 'en';
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/data')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(V2));
  }
  if (req.url.startsWith('/events')) {           // hold it open; never push
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.write(': open\n\n');
  }
  // Mirror server.mjs:249's own injection exactly: a <script> setting
  // window.__CRUCIX_LOCALE__, spliced before </head> so it runs before jarvis.html's inline
  // script reads it into `const L`. The fixture server serves the raw file, so this check has
  // to do that injection itself rather than exercising server.mjs.
  const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(LOCALES[currentLocale]).replace(/<\/script>/gi, '<\\/script>')};</script>`;
  const html = page.replace('</head>', `${localeScript}\n</head>`);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
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

const POLL_BADGE = `new Promise(res=>{const t0=Date.now();(function tick(){
  const n=document.querySelectorAll('.lp-ideas .ideas-src').length;
  if(n>0||Date.now()-t0>10000) res(n); else setTimeout(tick,150);})()})`;

// Drives one scenario by mutating D directly and re-invoking the real renderLower(), the same
// BREAK-case technique source-health-dom.mjs uses (`D.health = []; reinit();`). D and
// renderLower are top-level bindings in jarvis.html's inline classic script, so they are visible
// to later Runtime.evaluate calls in the same page realm.
const SET_AND_RENDER = (ideasSource, ideas) => `(() => {
  D.ideasSource = ${JSON.stringify(ideasSource)};
  D.ideas = ${JSON.stringify(ideas)};
  renderLower();
  return 'ok';
})()`;

const ASSERT = `(() => {
  const panel = document.querySelector('.lp-ideas');
  const badge = panel ? panel.querySelector('.sec-head .ideas-src') : null;
  const cards = panel ? panel.querySelectorAll('.idea-card').length : 0;
  const emptyWrap = panel ? [...panel.children].find(el =>
    el.tagName === 'DIV' && !el.classList.contains('sec-head') &&
    !el.classList.contains('disclosure') && !el.classList.contains('idea-card')) : null;
  const rect = emptyWrap ? emptyWrap.getBoundingClientRect() : null;
  const cs = emptyWrap ? getComputedStyle(emptyWrap) : null;
  return JSON.stringify({
    panelExists: !!panel,
    badgeClass: badge ? badge.className : null,
    badgeText: badge ? badge.textContent.trim() : null,
    cards,
    emptyHeading: emptyWrap ? (emptyWrap.children[1]?.textContent || '').trim() : null,
    emptyHelp: emptyWrap ? (emptyWrap.children[2]?.textContent || '').trim() : null,
    emptyW: rect ? rect.width : 0,
    emptyH: rect ? rect.height : 0,
    emptyDisplay: cs ? cs.display : null,
    emptyVisibility: cs ? cs.visibility : null,
  });
})()`;

const failures = [];
const must = (c, m) => { if (!c) failures.push(m); };

const { send, pageErrors, close } = await cdp();
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  for (const locale of ['en', 'fr']) {
    currentLocale = locale;
    const L = LOCALES[locale].ideas;

    await send('Page.navigate', { url: TARGET });
    const badgeCount = await ev(send, POLL_BADGE);
    must(badgeCount > 0, `${locale}: no .lp-ideas .ideas-src badge ever rendered — is renderLower() wiring the header badge?`);

    // Case 1 — 'rules' + non-empty: badge is 'ideas-src rules' with locale ideas.ruleBased, cards render.
    await ev(send, SET_AND_RENDER('rules', [{ type: 'long', ticker: 'XAU', horizon: 'swing',
      confidence: 'High', title: 'Test Rule Idea', text: 'rationale text' }]));
    let r = JSON.parse(await ev(send, ASSERT) || '{}');
    must(r.panelExists, `${locale}/rules-nonempty: .lp-ideas panel missing`);
    must(r.badgeClass === 'ideas-src rules',
      `${locale}/rules-nonempty: badge class is "${r.badgeClass}", expected "ideas-src rules"`);
    must(r.badgeText === L.ruleBased,
      `${locale}/rules-nonempty: badge text is "${r.badgeText}", expected locale value "${L.ruleBased}"`);
    must(r.cards > 0, `${locale}/rules-nonempty: expected idea card(s) to render, got ${r.cards}`);

    // Case 2 — 'rules' + empty: empty state shows ideas.noSignal / ideas.noSignalHelp, NOT
    // "LLM NOT CONFIGURED". This is the majority real-world case (59.6% of sweeps) and the
    // point of the check. Also assert visibility, not just presence.
    await ev(send, SET_AND_RENDER('rules', []));
    r = JSON.parse(await ev(send, ASSERT) || '{}');
    must(r.badgeClass === 'ideas-src rules',
      `${locale}/rules-empty: badge class is "${r.badgeClass}", expected "ideas-src rules"`);
    must(r.badgeText === L.ruleBased,
      `${locale}/rules-empty: badge text is "${r.badgeText}", expected locale value "${L.ruleBased}"`);
    must(r.cards === 0, `${locale}/rules-empty: expected 0 idea cards, got ${r.cards}`);
    must(!!r.emptyHeading, `${locale}/rules-empty: no empty-state heading element found`);
    must(r.emptyHeading === L.noSignal,
      `${locale}/rules-empty: empty-state heading is "${r.emptyHeading}", expected locale value "${L.noSignal}"`);
    must(r.emptyHeading !== 'LLM NOT CONFIGURED',
      `${locale}/rules-empty: empty-state still reads "LLM NOT CONFIGURED" for a rule source that simply found no signal`);
    must(r.emptyHelp === L.noSignalHelp,
      `${locale}/rules-empty: empty-state sub-line is "${r.emptyHelp}", expected locale value "${L.noSignalHelp}"`);
    must(r.emptyW > 0 && r.emptyH > 0,
      `${locale}/rules-empty: empty-state element has zero bounding box (${r.emptyW}x${r.emptyH})`);
    must(r.emptyDisplay !== 'none' && r.emptyVisibility !== 'hidden',
      `${locale}/rules-empty: empty-state element not visible (display:${r.emptyDisplay}, visibility:${r.emptyVisibility})`);

    // Case 3 — 'llm' (regression): badge is 'ideas-src llm' with locale ideas.aiEnhanced.
    await ev(send, SET_AND_RENDER('llm', [{ type: 'LONG', ticker: 'SPY', horizon: 'Days',
      confidence: 'HIGH', title: 'Test LLM Idea', text: 'rationale text' }]));
    r = JSON.parse(await ev(send, ASSERT) || '{}');
    must(r.badgeClass === 'ideas-src llm',
      `${locale}/llm: badge class is "${r.badgeClass}", expected "ideas-src llm"`);
    must(r.badgeText === L.aiEnhanced,
      `${locale}/llm: badge text is "${r.badgeText}", expected locale value "${L.aiEnhanced}"`);
    must(r.cards > 0, `${locale}/llm: expected idea card(s) to render, got ${r.cards}`);

    // Case 4 — unknown source (regression): catch-all still reachable, badge is
    // 'ideas-src static' with locale ideas.pending.
    await ev(send, SET_AND_RENDER('llm-failed', []));
    r = JSON.parse(await ev(send, ASSERT) || '{}');
    must(r.badgeClass === 'ideas-src static',
      `${locale}/unknown-source: badge class is "${r.badgeClass}", expected "ideas-src static"`);
    must(r.badgeText === L.pending,
      `${locale}/unknown-source: badge text is "${r.badgeText}", expected locale value "${L.pending}"`);
  }

  must(pageErrors.length === 0, `console errors: ${pageErrors.join(' | ')}`);
} finally {
  close();
  // The page holds /events open, so server.close() alone would wait forever for it.
  server.closeAllConnections();
  server.close();
}

if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('PASS — ideas panel renders the correct badge class + locale text and empty-state ' +
  'copy for rules/llm/unknown sources, in both en and fr; empty-state element is visible, not ' +
  'just present; console clean.');
