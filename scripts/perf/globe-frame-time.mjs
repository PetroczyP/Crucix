#!/usr/bin/env node
// Globe-mode regression guard (issue 016).
//
// Frame time ALONE is a wrong oracle: deleting the arcs, stopping rotation, or making the
// zoom handler return unconditionally are all fast AND broken. So this asserts the workload
// and the behaviour as well as the speed, and every check is fail-closed.
//
// Why this exists: globe.gl fires onZoom for rotation as well as zoom, so an unguarded
// zoom handler re-runs every altitude-dependent setter on each frame of auto-rotation and
// pushes redundant updates into the arc and point layers. That cost 58.1ms/frame (~17fps).
// The guard in plotMarkers() brings it to 8.3ms (~120fps). This script fails if that
// regresses.
//
// Zero dependencies: drives Chrome over the DevTools Protocol using Node 22+'s built-in
// WebSocket, so `tool/` keeps `express` as its only dependency.
//
// Lives under scripts/, NOT test/: `npm test` is `node --test`, which treats every file
// under test/ as a unit test. This one needs a browser and a served dashboard, so being
// discovered there broke the suite (issue 016 build round, AC-5).
//
//   npm run perf:globe                 # against http://localhost:3117
//   TARGET=http://host/jarvis.html npm run perf:globe
//
// Requires Chrome and a served dashboard. Exits non-zero on regression, page error, or
// short sample -- never on "looks fine".
const PORT = process.env.CDP_PORT || 9222;
const TARGET = process.env.TARGET || 'http://localhost:3117';
const ROUNDS = +(process.env.ROUNDS || 3);
const FRAMES = 150;
const THRESHOLD_MS = +(process.env.THRESHOLD_MS || 20);   // measured 8.3; unguarded was 58.1
const EXPECT_ARCS = +(process.env.EXPECT_ARCS || 74);      // the baked snapshot's full corridor set
const EXPECT_LABELLED = +(process.env.EXPECT_LABELLED || 39);
const EXPECT_RES = +(process.env.EXPECT_RES || 64);
const EVAL_TIMEOUT = 25000;

async function cdp() {
  let list;
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.length) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!list || !list.length) throw new Error(`no Chrome on CDP port ${PORT}. Start it with:\n` +
    `  chrome --headless=new --remote-debugging-port=${PORT} --user-data-dir=/tmp/cdp about:blank &`);
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const pageErrors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error('CDP error: ' + JSON.stringify(m.error))) : res(m); }
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      pageErrors.push(m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 140));
    else if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push('exception: ' + (m.params.exceptionDetails?.text || '').slice(0, 140));
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
const PACE = `new Promise(res=>{const d=[];let last=performance.now(),n=0;function tick(t){d.push(t-last);last=t;
  if(++n<${FRAMES})requestAnimationFrame(tick);else{const s=[...d].sort((a,b)=>a-b);
  res(JSON.stringify({med:+s[Math.floor(s.length*.5)].toFixed(2),over33:d.filter(x=>x>33).length}))}}requestAnimationFrame(tick)})`;

const { send, pageErrors, close } = await cdp();
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
// Block live data so the measurement uses the snapshot baked into jarvis.html and does not
// depend on whatever the current sweep contains (a failed sweep yields 0 arcs and would
// measure fast for the wrong reason -- see issue 006).
await send('Network.setBlockedURLs', { urls: ['*/api/data', '*/events'] });
await send('Emulation.setDeviceMetricsOverride', { width: 1728, height: 1080, deviceScaleFactor: 2, mobile: false });

const failures = [];
const must = (ok, msg) => { if (!ok) failures.push(msg); return ok; };
const meds = [];

// H-3: the dashboard restores `crucix_low_perf` (jarvis.html:407) and `crucix-layers`
// (:429-431) from localStorage before anything below can read a default. A profile where
// LITE was once chosen starts with rotation off; one where Air Activity was hidden renders
// zero arcs. Both are CORRECT behaviour and would make the assertions below report a
// regression that does not exist. So: land on the origin, clear those keys, and only then
// perform the measured navigation. This makes the guard independent of the attached profile.
await send('Page.navigate', { url: TARGET });
await new Promise(x => setTimeout(x, 1500));
const cleared = await ev(send, `(()=>{const before={
    perf: localStorage.getItem('crucix_low_perf'), layers: localStorage.getItem('crucix-layers')};
  localStorage.removeItem('crucix_low_perf'); localStorage.removeItem('crucix-layers');
  return JSON.stringify(before)})()`);
console.log(`  (cleared inherited preferences: ${cleared})`);

for (let r = 0; r < ROUNDS; r++) {
  await send('Page.navigate', { url: TARGET });
  await new Promise(x => setTimeout(x, 11000));
  await ev(send, `document.getElementById('projToggle').click()`);
  await new Promise(x => setTimeout(x, 5000));

  // --- workload: a fast build that renders nothing is not a passing build ---
  const scene = JSON.parse(await ev(send, `JSON.stringify({
    arcs: globe.arcsData().length,
    labelled: globe.arcsData().filter(a => a.label).length,
    res: globe.arcCurveResolution(),
    autoRotate: globe.controls().autoRotate })`));   // READ BEFORE we touch it: proves the default
  must(scene.arcs === EXPECT_ARCS, `scene: ${scene.arcs} arcs, expected ${EXPECT_ARCS}`);
  must(scene.labelled === EXPECT_LABELLED, `scene: ${scene.labelled} labelled arcs, expected ${EXPECT_LABELLED}`);
  must(scene.res === EXPECT_RES, `scene: curve resolution ${scene.res}, expected ${EXPECT_RES}`);
  must(scene.autoRotate === true, `autoRotate defaults to ${scene.autoRotate}, expected true`);

  // --- the camera must actually be moving; a frozen globe is trivially fast ---
  await ev(send, `globe.pointOfView({altitude:2.5},0); 'ok'`);
  await new Promise(x => setTimeout(x, 2000));
  const moved = JSON.parse(await ev(send, `new Promise(res=>{const a=globe.pointOfView();
    setTimeout(()=>{const b=globe.pointOfView();
      res(JSON.stringify({d:Math.abs(b.lng-a.lng)+Math.abs(b.lat-a.lat)}))},1500)})`));
  must(moved.d > 0.05, `viewpoint did not move during auto-rotation (delta ${moved.d})`);

  // --- the zoom contract, in full (AC-4). Each observable is asserted independently, so
  // deleting any ONE of the handler's altitude-dependent setters goes red on its own.
  const zoom = JSON.parse(await ev(send, `(async()=>{
    const pr=()=>{const f=globe.pointRadius();return typeof f==='function'?+f({size:1}).toFixed(6):f};
    const as=()=>{const f=globe.arcStroke();return typeof f==='function'?+f({stroke:1}).toFixed(6):f};
    const ls=()=>{const f=globe.labelSize();return typeof f==='function'?+f({size:1}).toFixed(6):f};
    const set=async a=>{globe.pointOfView({altitude:a},0);await new Promise(r=>setTimeout(r,700))};
    const src=[...document.querySelectorAll('script')].map(x=>x.textContent).join('');
    const m=src.match(/const ZOOM_EPSILON\\s*=\\s*([0-9.]+)/);
    const wasRot=globe.controls().autoRotate; globe.controls().autoRotate=false;
    // first callback after a fresh registration must run even for a SUB-epsilon step
    await set(1.5); plotMarkers(); await new Promise(r=>setTimeout(r,700));
    const p0=pr(); await set(1.502); const p1=pr();
    // and once warm, a sub-epsilon step must be suppressed (the guard is live)
    await set(1.5035); const p2=pr();
    // the fixed 0.02 step must move all three accessors, and cross the label boundary both ways
    await set(1.79); const a={p:pr(),s:as(),l:ls()};
    await set(1.81); const b={p:pr(),s:as(),l:ls()};
    await set(1.79); const c={p:pr(),s:as(),l:ls()};
    globe.controls().autoRotate=wasRot;
    return JSON.stringify({eps:m?parseFloat(m[1]):null,firstCb:p0!==p1,warmSuppressed:p1===p2,a,b,c})})()`));
  must(typeof zoom.eps === 'number' && zoom.eps < 0.02, `ZOOM_EPSILON is ${zoom.eps}, must be < 0.02`);
  must(zoom.firstCb, 'first callback after a fresh plotMarkers() registration was swallowed');
  must(zoom.warmSuppressed, 'a warm sub-epsilon step was NOT suppressed — the guard is not live');
  must(zoom.a.p !== zoom.b.p && zoom.b.p !== zoom.c.p, `pointRadius does not track zoom (${zoom.a.p}/${zoom.b.p}/${zoom.c.p})`);
  must(zoom.a.s !== zoom.b.s && zoom.b.s !== zoom.c.s, `arcStroke does not track zoom (${zoom.a.s}/${zoom.b.s}/${zoom.c.s})`);
  must(zoom.a.l > 0 && zoom.b.l === 0 && zoom.c.l > 0, `label visibility does not cross alt<1.8 both ways (${zoom.a.l}/${zoom.b.l}/${zoom.c.l})`);

  const p = JSON.parse(await ev(send, PACE));
  meds.push(p.med);
  console.log(`  run ${r + 1}/${ROUNDS}  median ${p.med}ms  frames>33ms ${p.over33}/${FRAMES}  ` +
              `arcs=${scene.arcs}/${scene.labelled} res=${scene.res} rot=${scene.autoRotate} ` +
              `eps=${zoom.eps} firstCb=${zoom.firstCb} warmSup=${zoom.warmSuppressed} ` +
              `pr=${zoom.a.p}->${zoom.b.p} as=${zoom.a.s}->${zoom.b.s} ls=${zoom.a.l}->${zoom.b.l}`);
}
const sorted = [...meds].sort((a, b) => a - b);
const upperMedian = sorted[Math.floor(sorted.length / 2)];
console.log(`\nglobe-mode frame time: upper-median ${upperMedian}ms  (threshold ${THRESHOLD_MS}ms)`);
close();
if (pageErrors.length) { console.error(`FAIL: ${pageErrors.length} page error(s):\n  ${pageErrors.slice(0, 5).join('\n  ')}`); process.exit(1); }
if (meds.length < ROUNDS) { console.error(`FAIL: only ${meds.length}/${ROUNDS} runs completed`); process.exit(1); }
if (failures.length) {
  console.error(`FAIL: the build is fast but not correct —\n  ${[...new Set(failures)].join('\n  ')}`);
  process.exit(1);
}
if (upperMedian > THRESHOLD_MS) { console.error(`FAIL: ${upperMedian}ms exceeds ${THRESHOLD_MS}ms — the zoom guard may have regressed (jarvis.html, plotMarkers)`); process.exit(1); }
console.log('PASS');
