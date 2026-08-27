// Issue 013 — the rule-based trade-idea fallback, wired at last.
//
// generateIdeas() sat imported-but-uncalled since the initial commit (git log -S proves it).
// This file proves it is now actually invoked — call provenance, not array length, per the
// spec's own warning: under the revised thresholds 59.6% of historical sweeps produce zero
// ideas, so `ideas.length > 0` is not a weak oracle here, it is a WRONG one. Every assertion
// below keys on `ideasSource === 'rules'` and/or named titles, never on bare array length
// except where length itself is the property under test (the removed slice(0, 8) cap).
//
// Covers AC-1 (six wiring sites, by source text), AC-2 (all 10 rules / 11 push sites, fire
// and no-fire, plus the nine-rule co-fire fixture), AC-3 (FRED present/absent), AC-8
// (threshold boundaries, the two rule deletions, the toFixed crash regression, the removed
// cap) and AC-9 (previousIdeas ordering, both defects, via a real MemoryManager on a temp dir).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateIdeas } from '../dashboard/inject.mjs';
import { MemoryManager } from '../lib/delta/index.mjs';

const ROOT = new URL('../', import.meta.url);
const serverSrc = readFileSync(fileURLToPath(new URL('server.mjs', ROOT)), 'utf8');
const injectSrc = readFileSync(fileURLToPath(new URL('dashboard/inject.mjs', ROOT)), 'utf8');

// ─── AC-1 — the six wiring sites, as call provenance in source text ──────────────────────
//
// The oracle is NOT "ideas.length > 0" (the spec names this the wrong oracle explicitly).
// It is: does this exact site assign `generateIdeas(...)` AND label the source 'rules'? A
// build that keeps the label but reverts the assignment to `[]` is the one broken shape the
// spec calls out by name, and it must not be present in either file.

describe('AC-1 — every dead path now calls generateIdeas and labels the source rules', () => {
  test('server.mjs: exactly 3 sweep-path sites assign generateIdeas(synthesized) AND ideasSource = \'rules\'', () => {
    const pattern = /synthesized\.ideas\s*=\s*generateIdeas\(synthesized\);\s*\n\s*synthesized\.ideasSource\s*=\s*'rules';/g;
    const hits = [...serverSrc.matchAll(pattern)];
    assert.equal(hits.length, 3,
      `expected exactly 3 sites in server.mjs pairing generateIdeas(synthesized) with ideasSource='rules', found ${hits.length}`);
  });

  test('inject.mjs cliInject: exactly 3 sites assign generateIdeas(V2) AND ideasSource = \'rules\'', () => {
    const pattern = /V2\.ideas\s*=\s*generateIdeas\(V2\);\s*\n\s*V2\.ideasSource\s*=\s*'rules';/g;
    const hits = [...injectSrc.matchAll(pattern)];
    assert.equal(hits.length, 3,
      `expected exactly 3 sites in inject.mjs pairing generateIdeas(V2) with ideasSource='rules', found ${hits.length}`);
  });

  test('neither file assigns a bare [] alongside a \'rules\' label (the exact broken build)', () => {
    // A revert of ONLY the generateIdeas(...) assignment to [], leaving the 'rules' label in
    // place, is the one-change mutant AC-1 requires to fail. This pattern is what that mutant
    // would leave behind, and it must not exist in the shipped source.
    const broken = /\.ideas\s*=\s*\[\];[\s\S]{0,80}?\.ideasSource\s*=\s*'rules'/;
    assert.equal(broken.test(serverSrc), false, "server.mjs must not pair ideas = [] with ideasSource = 'rules'");
    assert.equal(broken.test(injectSrc), false, "inject.mjs must not pair ideas = [] with ideasSource = 'rules'");
  });
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────────────────
//
// The minimal V2 that generateIdeas dereferences unconditionally without throwing. Every
// rule fixture below starts from this and adds only what that rule needs, so a fixture that
// makes a rule fire is never accidentally relying on a field the function doesn't read.
function baseV2() {
  return { fred: [], bls: [], thermal: [], tg: { urgent: [] }, energy: { wtiRecent: [] }, treasury: {} };
}

// The nine-rule co-fire fixture (AC-2, AC-8). Verified by hand against the current
// generateIdeas() and re-verified by the test run itself: Safe Haven Demand Rising is the
// TENTH rule and the one that does NOT fire here (hy = 2, needs > 3), which is what makes
// nine — not ten — the right number for this specific input.
const NINE_RULE_V2 = {
  fred: [{ id: 'VIXCLS', value: 30 }, { id: 'BAMLH0A0HYM2', value: 2 }, { id: 'T10Y2Y', value: 0.5 }],
  bls: [
    { id: 'LNS14000000', value: 5.0 },
    { id: 'CES0000000001', momChange: -60 },
    { id: 'WPUFD49104', momChangePct: 0.9 },
    { id: 'CUUR0000SA0', value: 300 },
  ],
  thermal: [{ region: 'x', det: 31000 }],
  tg: { urgent: [1, 2, 3, 4] },
  energy: { wti: 100, wtiRecent: [104, 100] },
  treasury: { totalDebt: '40000000000000' },
  acled: { totalEvents: 100, totalFatalities: 600 },
  gscpi: { value: 0.9, interpretation: 'high' },
};
const NINE_RULE_ORDER = [
  'Conflict-Energy Nexus Active',
  'Elevated Volatility Regime',
  'Oil Momentum Building',
  'Satellite Confirms Conflict Intensity',
  'Steepening Curve Meets Weak Labor',
  'Conflict Fueling Energy Momentum',
  'Defense Procurement Acceleration Signal',
  'Equity Fear Exceeds Credit Stress',
  'Inflation Pipeline Building Pressure',
];

// ─── AC-2 — every retained rule, fires and does-not-fire ─────────────────────────────────
//
// 10 rules / 11 push sites remain after the AC-8 deletions (Yield Curve, Fiscal Trajectory).
// One rule (HY/VIX divergence) has two mutually exclusive titles from two push sites, so this
// table has 11 rows — one per push site, which is a strictly finer grain than "one per rule"
// and proves both branches independently. Each fixture isolates the rule's own gating
// condition: the "does not fire" case holds every OTHER leg of that rule true and flips only
// the one leg under test, so a mutated threshold on that leg is what the pair is built to catch.
const RULES = [
  {
    title: 'Conflict-Energy Nexus Active',
    fire: () => { const v = baseV2(); v.tg.urgent = [1, 2, 3, 4]; v.energy.wti = 96; return v; },
    noFire: () => { const v = baseV2(); v.tg.urgent = [1, 2, 3, 4]; v.energy.wti = 90; return v; },
  },
  {
    title: 'Elevated Volatility Regime',
    fire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 21 }]; return v; },
    noFire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 19 }]; return v; },
  },
  {
    title: 'Safe Haven Demand Rising',
    fire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 21 }, { id: 'BAMLH0A0HYM2', value: 4 }]; return v; },
    noFire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 21 }, { id: 'BAMLH0A0HYM2', value: 2 }]; return v; },
  },
  {
    title: 'Oil Momentum Building',
    fire: () => { const v = baseV2(); v.energy = { wti: 104, wtiRecent: [104, 100] }; return v; },
    noFire: () => { const v = baseV2(); v.energy = { wti: 101, wtiRecent: [101, 100] }; return v; },
  },
  {
    title: 'Satellite Confirms Conflict Intensity',
    fire: () => { const v = baseV2(); v.thermal = [{ region: 'x', det: 31000 }]; v.tg.urgent = [1, 2, 3]; return v; },
    noFire: () => { const v = baseV2(); v.thermal = [{ region: 'x', det: 31000 }]; v.tg.urgent = [1, 2]; return v; },
  },
  {
    title: 'Steepening Curve Meets Weak Labor',
    fire: () => {
      const v = baseV2();
      v.fred = [{ id: 'T10Y2Y', value: 0.5 }];
      v.bls = [{ id: 'LNS14000000', value: 4.5 }, { id: 'CES0000000001', momChange: -10 }];
      return v;
    },
    noFire: () => {
      const v = baseV2();
      v.fred = [{ id: 'T10Y2Y', value: 0.5 }];
      v.bls = [{ id: 'LNS14000000', value: 4.0 }, { id: 'CES0000000001', momChange: -10 }];
      return v;
    },
  },
  {
    title: 'Conflict Fueling Energy Momentum',
    fire: () => { const v = baseV2(); v.acled = { totalEvents: 60 }; v.energy.wtiRecent = [105, 100]; return v; },
    noFire: () => { const v = baseV2(); v.acled = { totalEvents: 60 }; v.energy.wtiRecent = [101, 100]; return v; },
  },
  {
    title: 'Defense Procurement Acceleration Signal',
    fire: () => { const v = baseV2(); v.acled = { totalFatalities: 600 }; v.thermal = [{ region: 'x', det: 21000 }]; return v; },
    noFire: () => { const v = baseV2(); v.acled = { totalFatalities: 600 }; v.thermal = [{ region: 'x', det: 19000 }]; return v; },
  },
  {
    title: 'Credit Stress Ignored by Equity Vol',
    fire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 15 }, { id: 'BAMLH0A0HYM2', value: 4 }]; return v; },
    noFire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 15 }, { id: 'BAMLH0A0HYM2', value: 3 }]; return v; },
  },
  {
    title: 'Equity Fear Exceeds Credit Stress',
    fire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 30 }, { id: 'BAMLH0A0HYM2', value: 2 }]; return v; },
    noFire: () => { const v = baseV2(); v.fred = [{ id: 'VIXCLS', value: 30 }, { id: 'BAMLH0A0HYM2', value: 3 }]; return v; },
  },
  {
    title: 'Inflation Pipeline Building Pressure',
    fire: () => {
      const v = baseV2();
      v.bls = [{ id: 'WPUFD49104', momChangePct: 0.9 }, { id: 'CUUR0000SA0', value: 300 }];
      v.gscpi = { value: 0.9, interpretation: 'high' };
      return v;
    },
    noFire: () => {
      const v = baseV2();
      v.bls = [{ id: 'WPUFD49104', momChangePct: 0.1 }, { id: 'CUUR0000SA0', value: 300 }];
      v.gscpi = { value: 0.9, interpretation: 'high' };
      return v;
    },
  },
];

describe('AC-2 — every retained rule fires and does not fire', () => {
  assert.equal(RULES.length, 11, 'this table must cover exactly the 11 retained push sites');

  for (const rule of RULES) {
    test(`${rule.title}: fires`, () => {
      const ideas = generateIdeas(rule.fire());
      assert.ok(ideas.some(i => i.title === rule.title),
        `expected "${rule.title}" to fire, got [${ideas.map(i => i.title).join(', ')}]`);
    });

    test(`${rule.title}: does not fire`, () => {
      const ideas = generateIdeas(rule.noFire());
      assert.ok(!ideas.some(i => i.title === rule.title),
        `expected "${rule.title}" to be absent, got [${ideas.map(i => i.title).join(', ')}]`);
    });
  }

  // Bonus coverage of the oil rule's OTHER branch — same push site as 'Oil Momentum
  // Building' above, so it is not counted as a 12th row, but a mutation flipping the sign
  // check would still slip past a suite that only ever drove the positive branch.
  test('Oil Under Pressure: the negative branch of the same push site fires on a falling WTI', () => {
    const v = baseV2();
    v.energy = { wti: 96, wtiRecent: [96, 100] }; // -4% move
    const ideas = generateIdeas(v);
    assert.ok(ideas.some(i => i.title === 'Oil Under Pressure'),
      `expected "Oil Under Pressure", got [${ideas.map(i => i.title).join(', ')}]`);
  });

  test('nine rules co-fire simultaneously, returned in push order, uncapped', () => {
    const ideas = generateIdeas(NINE_RULE_V2);
    assert.deepEqual(ideas.map(i => i.title), NINE_RULE_ORDER,
      `expected exactly these 9 titles in push order, got ${JSON.stringify(ideas.map(i => i.title))}`);
    assert.equal(ideas.length, 9, 'the slice(0, 8) cap must be gone — all nine fired rules must be returned');
  });
});

// ─── AC-3 — FRED present and absent ───────────────────────────────────────────────────────

describe('AC-3 — FRED present vs absent (fred: [], not an env clear)', () => {
  const FRED_DEPENDENT = [
    'Elevated Volatility Regime',
    'Steepening Curve Meets Weak Labor',
    'Equity Fear Exceeds Credit Stress',
  ];
  const FRED_INDEPENDENT = NINE_RULE_ORDER.filter(t => !FRED_DEPENDENT.includes(t));

  test('FRED present: FRED-dependent rules fire alongside the FRED-independent ones, no throw', () => {
    let ideas;
    assert.doesNotThrow(() => { ideas = generateIdeas(NINE_RULE_V2); });
    const titles = ideas.map(i => i.title);
    for (const t of FRED_DEPENDENT) assert.ok(titles.includes(t), `expected "${t}" with FRED present`);
    for (const t of FRED_INDEPENDENT) assert.ok(titles.includes(t), `expected "${t}" regardless of FRED`);
    assert.equal(ideas.length, 9);
  });

  test('FRED absent (fred: []): FRED-dependent rules disappear, the rest survive, no throw', () => {
    const withoutFred = { ...NINE_RULE_V2, fred: [] };
    let ideas;
    assert.doesNotThrow(() => { ideas = generateIdeas(withoutFred); });
    const titles = ideas.map(i => i.title);
    for (const t of FRED_DEPENDENT) assert.ok(!titles.includes(t), `"${t}" must not fire without FRED`);
    for (const t of FRED_INDEPENDENT) assert.ok(titles.includes(t), `expected "${t}" to survive FRED absence`);
    assert.equal(ideas.length, NINE_RULE_ORDER.length - FRED_DEPENDENT.length);
  });
});

// ─── AC-8 — thresholds and deletions ───────────────────────────────────────────────────────

describe('AC-8 — thresholds and deletions', () => {
  test('energy.wti boundary: just above 95 fires, just below does not (urgent held > 3)', () => {
    const above = baseV2(); above.tg.urgent = [1, 2, 3, 4]; above.energy.wti = 95.01;
    const below = baseV2(); below.tg.urgent = [1, 2, 3, 4]; below.energy.wti = 94.99;
    assert.ok(generateIdeas(above).some(i => i.title === 'Conflict-Energy Nexus Active'),
      'wti = 95.01 with urgent > 3 must fire');
    assert.ok(!generateIdeas(below).some(i => i.title === 'Conflict-Energy Nexus Active'),
      'wti = 94.99 with urgent > 3 must not fire');
  });

  test('energy.wti exactly at 95 does not fire — the threshold is a strict >', () => {
    const v = baseV2(); v.tg.urgent = [1, 2, 3, 4]; v.energy.wti = 95;
    assert.ok(!generateIdeas(v).some(i => i.title === 'Conflict-Energy Nexus Active'));
  });

  test('"Yield Curve Normalizing" can never be produced', () => {
    assert.ok(!injectSrc.includes('Yield Curve Normalizing'),
      'the deleted rule\'s title string must not exist anywhere in inject.mjs');
    // Drive a fixture shaped to satisfy the deleted rule's old (thresholdless — "fires
    // whenever FRED works") condition: a populated T10Y2Y spread, nothing else.
    const v = baseV2();
    v.fred = [{ id: 'T10Y2Y', value: 0.5 }];
    assert.ok(!generateIdeas(v).some(i => i.title === 'Yield Curve Normalizing'));
  });

  test('"Fiscal Trajectory Supports Hard Assets" can never be produced', () => {
    assert.ok(!injectSrc.includes('Fiscal Trajectory Supports Hard Assets'),
      'the deleted rule\'s title string must not exist anywhere in inject.mjs');
    // Drive a fixture far beyond the deleted rule's old debt > 35e12 threshold.
    const v = baseV2();
    v.treasury = { totalDebt: 90e12 };
    assert.ok(!generateIdeas(v).some(i => i.title === 'Fiscal Trajectory Supports Hard Assets'));
  });

  test('crash regression: a T10Y2Y record with no .value must return [], not throw', () => {
    // Before this issue, `if (spread)` alone reached `spread.value.toFixed(2)` and threw
    // TypeError on any T10Y2Y record lacking `value`, taking down the whole sweep's ideas.
    const v = baseV2();
    v.fred = [{ id: 'T10Y2Y' }];
    let ideas;
    assert.doesNotThrow(() => { ideas = generateIdeas(v); },
      'generateIdeas must not throw on a valueless T10Y2Y record');
    assert.deepEqual(ideas, []);
  });

  test('the returned array is never truncated at 8 (nine-rule fixture, again, for AC-8)', () => {
    const ideas = generateIdeas(NINE_RULE_V2);
    assert.equal(ideas.length, 9, 'slice(0, 8) must be removed from generateIdeas');
  });
});

// ─── AC-9 — memory ordering: previousIdeas reads the previous run, not this one ───────────
//
// Two defects, proven across two consecutive sweeps because one sweep cannot distinguish
// "persisted" from "never read": (i) addRun used to snapshot before ideas were assigned, so
// stored ideas were always []; (ii) addRun unshifted the new run before reading it back, so
// even with (i) fixed, "previous" meant "this sweep". prepareDelta()/persist() split fixes
// both by reading getLastRun() before any mutation and persisting only after ideas exist.

function sweepFixture(timestamp, sourcesOk, vix, ideas) {
  return {
    meta: { timestamp, sourcesOk },
    fred: [{ id: 'VIXCLS', value: vix }],
    bls: [], thermal: [], tg: { urgent: [] }, energy: { wti: 80, wtiRecent: [] }, treasury: {},
    ideas,
  };
}
// _compactForStorage keeps only {title, type, confidence} per idea — this is the shape
// persisted, and therefore the shape a correct previousIdeas read must equal.
const compactIdeas = (ideas) => ideas.map(i => ({ title: i.title, type: i.type, confidence: i.confidence }));

describe('AC-9 — memory ordering, both defects', () => {
  test('sweep 1: previousIdeas empty. sweep 2: previousIdeas = sweep 1\'s ideas, not its own. persisted ideas match what was served', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crucix-ideas-fallback-'));
    try {
      const memory = new MemoryManager(dir);

      const sweep1Ideas = [{ title: 'Sweep1 Idea', text: 't1', type: 'watch', confidence: 'Medium', horizon: 'swing' }];
      const sweep1 = sweepFixture('2026-01-01T00:00:00.000Z', 25, 15, sweep1Ideas);
      const { delta: delta1, previousIdeas: prev1 } = memory.prepareDelta(sweep1);
      assert.deepEqual(prev1, [], "sweep 1's previousIdeas must be empty — nothing persisted yet");
      memory.persist(sweep1, delta1);

      const sweep2Ideas = [{ title: 'Sweep2 Idea', text: 't2', type: 'long', confidence: 'High', horizon: 'tactical' }];
      const sweep2 = sweepFixture('2026-01-01T00:15:00.000Z', 26, 16, sweep2Ideas);
      const { delta: delta2, previousIdeas: prev2 } = memory.prepareDelta(sweep2);

      assert.deepEqual(prev2, compactIdeas(sweep1Ideas),
        "sweep 2's previousIdeas must equal sweep 1's persisted ideas");
      assert.notDeepEqual(prev2, compactIdeas(sweep2Ideas),
        "sweep 2's previousIdeas must NOT equal its own ideas — the second defect (addRun unshifted before the read)");

      memory.persist(sweep2, delta2);

      const last = memory.getLastRun();
      assert.deepEqual(last.ideas, compactIdeas(sweep2Ideas),
        'the persisted run must carry the ideas actually served, not []');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('addRun (legacy) and prepareDelta()+persist() produce an identical delta for identical input', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'crucix-ideas-fallback-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'crucix-ideas-fallback-b-'));
    try {
      const memoryA = new MemoryManager(dirA);
      const memoryB = new MemoryManager(dirB);

      // Seed both instances with byte-identical prior state, via the same call shape.
      const seed = sweepFixture('2026-01-01T00:00:00.000Z', 25, 15, []);
      const { delta: seedDeltaA } = memoryA.prepareDelta(seed);
      memoryA.persist(seed, seedDeltaA);
      const { delta: seedDeltaB } = memoryB.prepareDelta(seed);
      memoryB.persist(seed, seedDeltaB);

      const next = sweepFixture('2026-01-01T00:15:00.000Z', 26, 22,
        [{ title: 'X', text: 't', type: 'watch', confidence: 'Medium', horizon: 'swing' }]);

      const deltaFromAddRun = memoryA.addRun(next);
      const { delta: deltaManual } = memoryB.prepareDelta(next);
      memoryB.persist(next, deltaManual);

      assert.deepEqual(deltaFromAddRun, deltaManual,
        'addRun (legacy) must produce a delta byte-identical to manual prepareDelta()+persist() for the same input');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 — rule ideas reach each consumer, asserted AT the consumer.
//
// The dashboard consumer is covered by `npm run check:ideas-panel` (a real browser).
// The two `/brief` digests cannot be driven live — neither Telegram nor Discord is
// configured — so they are asserted here against the SHIPPED expression, extracted
// from server.mjs rather than reimplemented. Reimplementing the thing under test is
// how the r1 calibration went wrong; it is not repeated here.
// ---------------------------------------------------------------------------
describe('AC-4 — rule ideas render correctly at both /brief consumers', () => {
  const serverSrc = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

  // The literal emoji ternary as it appears in the tree, at both digest sites.
  const TERNARY = "idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'";

  test('both digests carry the same idea-type expression, so neither can drift alone', () => {
    const hits = serverSrc.split(TERNARY).length - 1;
    assert.equal(hits, 2, 'expected the identical idea-type ternary at both the Telegram and Discord /brief sites');
  });

  test('every type the rule engine can emit is named by the digests', () => {
    // Drive every retained rule, then collect the full set of emitted `type` values.
    const emitted = new Set(generateIdeas(structuredClone(NINE_RULE_V2)).map(i => i.type));
    for (const t of emitted) {
      assert.ok(
        ['long', 'hedge', 'watch'].includes(t),
        `rule engine emits type "${t}", which the /brief digests do not handle — it would fall to the default glyph`,
      );
    }
    // long and hedge get distinct glyphs; watch is the intentional default.
    assert.ok(emitted.has('long') && emitted.has('hedge') && emitted.has('watch'),
      'fixture should exercise all three rule-dialect types');
  });

  test('the digests speak the rule dialect, not the LLM dialect (pins backlog 021)', () => {
    // Documented, deliberate gap: LLM ideas use uppercase LONG/HEDGE, so every LLM
    // idea already renders with the default glyph today. 013 does not fix that
    // (D-3, backlog 021) — this test pins the asymmetry so it stays visible.
    assert.ok(serverSrc.includes("idea.type === 'long'"),
      'digest tests the lowercase rule dialect');
    assert.ok(!serverSrc.includes(`idea.type === 'LONG'`),
      'digest does not handle the LLM uppercase dialect — backlog 021, deliberately out of scope here');
  });
});
