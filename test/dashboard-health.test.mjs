// Issue 006 — V2.health must describe every source every sweep, including failed ones,
// and lib/delta/engine.mjs's source_degradation signal must keep working because of it.
//
// Why this file exists: health was built by iterating `data.sources`, which only ever
// held survivors. A source marked `error` therefore VANISHED from the grid instead of
// showing as failed, and source_degradation — the only alert that fires on source
// failure — could never see it. Building health from `timing` fixes both.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { synthesize } from '../dashboard/inject.mjs';
import { computeDelta } from '../lib/delta/engine.mjs';

const SOURCES = [
  'GDELT', 'OpenSky', 'FIRMS', 'Maritime', 'Safecast', 'ACLED', 'ReliefWeb', 'WHO', 'OFAC',
  'OpenSanctions', 'ADS-B', 'FRED', 'Treasury', 'BLS', 'EIA', 'GSCPI', 'USAspending', 'Comtrade',
  'NOAA', 'EPA', 'Patents', 'Bluesky', 'Reddit', 'Telegram', 'KiwiSDR', 'Space', 'YFinance',
  'CISA-KEV', 'Cloudflare-Radar',
];

// A briefing-shaped fixture with the two DISTINCT failure shapes runSource produces:
//
//   `failed`  — the adapter resolved carrying an error. 006 keeps its payload, so it is
//               present in `sources` AND in `timing` with status 'error'.
//   `thrown`  — the adapter threw or timed out. Nothing resolved, so it is ABSENT from
//               `sources` and appears ONLY in `timing`.
//
// The second shape is the one that matters for the regression: an implementation that
// builds health by iterating `sources` cannot see it at all. A fixture containing only
// the first shape passes against BOTH the old and new implementations, which makes it a
// confirming test — this fixture deliberately contains both.
function fixture(failed = [], thrown = []) {
  const present = SOURCES.filter(n => !thrown.includes(n));
  return {
    crucix: {
      version: '2.0.0', timestamp: new Date().toISOString(), totalDurationMs: 1000,
      sourcesQueried: SOURCES.length,
      sourcesOk: SOURCES.length - failed.length - thrown.length,
      sourcesFailed: failed.length + thrown.length,
    },
    sources: Object.fromEntries(present.map(n =>
      [n, failed.includes(n) ? { error: `${n} upstream failed` } : {}])),
    errors: [...failed, ...thrown].map(n => ({ name: n, error: `${n} failed` })),
    timing: Object.fromEntries(SOURCES.map(n =>
      [n, { status: (failed.includes(n) || thrown.includes(n)) ? 'error' : 'ok', ms: 10 }])),
  };
}

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  // synthesize() fetches 19 RSS feeds; keep this test offline and deterministic.
  globalThis.fetch = async () => new Response('<rss><channel></channel></rss>', { status: 200 });
});
after(() => { globalThis.fetch = realFetch; });

test('health describes all 29 sources, including ones that never resolved', async () => {
  // GDELT threw, so it is absent from `sources` entirely — it must still appear here.
  const v2 = await synthesize(fixture(['EPA', 'FRED'], ['GDELT']));
  assert.equal(v2.health.length, SOURCES.length);
  assert.deepEqual([...v2.health.map(h => h.n)].sort(), [...SOURCES].sort());
});

test('both failure shapes are marked err — resolved-with-error AND thrown', async () => {
  const failed = ['EPA', 'FRED'];
  const thrown = ['GDELT'];
  const v2 = await synthesize(fixture(failed, thrown));
  const errored = v2.health.filter(h => h.err).map(h => h.n).sort();
  assert.deepEqual(errored, [...failed, ...thrown].sort());
  assert.equal(v2.health.filter(h => !h.err).length, SOURCES.length - failed.length - thrown.length);
});

test('an all-healthy sweep marks nothing err', async () => {
  const v2 = await synthesize(fixture([]));
  assert.equal(v2.health.filter(h => h.err).length, 0);
});

test('source_degradation fires at three new failures', async () => {
  // engine.mjs requires curr > prev + 2, so three is the smallest number that fires.
  const previous = await synthesize(fixture([]));
  const current = await synthesize(fixture(['EPA', 'FRED'], ['GDELT']));
  const delta = computeDelta(current, previous);
  const keys = (delta.signals?.new || []).map(s => s.key);
  assert.ok(keys.includes('source_degradation'), `expected source_degradation, got ${keys.join(',')}`);
});

test('source_degradation does NOT fire at two — the threshold is exact', async () => {
  const previous = await synthesize(fixture([]));
  const current = await synthesize(fixture(['EPA'], ['GDELT']));
  const delta = computeDelta(current, previous);
  const keys = (delta.signals?.new || []).map(s => s.key);
  assert.ok(!keys.includes('source_degradation'), 'two failures must not trip the > prev + 2 threshold');
});
