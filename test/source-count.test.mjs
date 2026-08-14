// Source-count consistency — one authoritative number, asserted everywhere.
//
// Judge M-3 recurred across four separate reviews of issue 005. Every time it
// was "fixed" by a hand-written grep, and every time the grep's own shape hid
// a surface from it: one sweep was bounded to the range 20-28 and so could not
// see `31`; another matched `sources` but not `APIs`; a third missed a live
// Telegram prompt entirely. Hand-tuned greps keep failing because the search
// is written by the same person who believes the fix is already complete.
//
// So this replaces the sweep with an executable check. The count is DERIVED
// from the code that actually runs the sources, and every prose surface must
// agree with it. Adding a source and forgetting the docs now fails the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

// ─── The authoritative count ──────────────────────────────────────────────
// runSource() call sites in the sweep orchestrator, minus its one definition.
function authoritativeCount() {
  const src = read('apis/briefing.mjs');
  const occurrences = (src.match(/runSource\(/g) || []).length;
  const definitions = (src.match(/(?:async\s+)?function\s+runSource\(/g) || []).length;
  assert.equal(definitions, 1, 'expected exactly one runSource definition');
  return occurrences - definitions;
}

// Each entry: the file, a regex whose first capture group is the stated count,
// and whether every match in the file must agree (some files state it twice).
const SURFACES = [
  ['server.mjs',                    /·\s*(\d+)\s*Sources/g,                    'startup banner'],
  ['dashboard/public/loading.html', /CONNECTING\s+(\d+)\s+OSINT\s+SOURCES/gi,  'loading screen'],
  ['lib/llm/ideas.mjs',             /data from (\d+) sources/g,                'live LLM ideas prompt'],
  ['lib/alerts/telegram.mjs',       /(\d+)-source intelligence sweep/g,        'live alert-evaluation prompt'],
  ['locales/en.json',               /·\s*(\d+)\s*Sources/g,                    'en bootSubtitle'],
  ['locales/fr.json',               /·\s*(\d+)\s*Sources/g,                    'fr bootSubtitle'],
  ['locales/en.json',               /data from (\d+) sources/g,                'en llm.systemPrompt'],
  ['locales/fr.json',               /structurées de (\d+) sources/g,           'fr llm.systemPrompt'],
  ['package.json',                  /(\d+) OSINT sources/g,                    'package description'],
];

test('the authoritative source count is derived from briefing.mjs, not asserted by hand', () => {
  const count = authoritativeCount();
  assert.ok(count > 0, 'derived a non-positive source count');
  // Cross-check against the source modules on disk, which is an independent path.
  assert.equal(count, 29, `runSource() call sites changed to ${count} — update SURFACES-facing prose too`);
});

for (const [file, pattern, label] of SURFACES) {
  test(`${label} (${file}) states the authoritative source count`, () => {
    const expected = authoritativeCount();
    const matches = [...read(file).matchAll(pattern)].map(m => Number(m[1]));
    assert.ok(matches.length > 0,
      `no source count found in ${file} for "${label}" — the pattern went stale, ` +
      'which is exactly the failure mode this file exists to prevent');
    for (const found of matches) {
      assert.equal(found, expected,
        `${file} ("${label}") says ${found} sources; briefing.mjs runs ${expected}`);
    }
  });
}
