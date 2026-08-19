// Issue 006 — runSource() must classify a resolved-but-failed value as an error,
// without discarding the payload it carries.
//
// Why this file exists: safeFetch() resolves rather than throws for operational
// failures, so before this change no source could ever be marked `error` from a
// data-level failure — only a literal throw or the 30s timeout could do it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../apis/briefing.mjs';

test('resolved value carrying an error string is classified error', async () => {
  const r = await runSource('T', async () => ({ error: 'boom', kept: 1 }));
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'boom');
});

test('an errored source KEEPS its payload — reporting failure must not delete data', async () => {
  // The contract's load-bearing property. briefing.mjs filters `sources` on
  // `data !== undefined`, so a partially-successful adapter keeps what it obtained.
  const r = await runSource('T', async () => ({ error: 'one of 21 failed', indicators: [1, 2, 3] }));
  assert.equal(r.status, 'error');
  assert.deepEqual(r.data.indicators, [1, 2, 3]);
});

test('a clean resolved value stays ok', async () => {
  const r = await runSource('T', async () => ({ ok: true }));
  assert.equal(r.status, 'ok');
  assert.equal(r.error, undefined);
});

test('configured absence is NOT an error (D-4)', async () => {
  // An adapter that issued no request for want of a key is not failing; marking it
  // red every sweep would make the signal permanently on and therefore useless.
  for (const status of ['no_key', 'no_credentials', 'limited', 'ready']) {
    const r = await runSource('T', async () => ({ status, message: 'not configured' }));
    assert.equal(r.status, 'ok', `${status} must not be classified as an error`);
  }
});

test('an empty error string is not an error', async () => {
  const r = await runSource('T', async () => ({ error: '' }));
  assert.equal(r.status, 'ok');
});

test('a non-string error field is not treated as an error message', async () => {
  const r = await runSource('T', async () => ({ error: { code: 500 } }));
  assert.equal(r.status, 'ok');
});

test('a thrown rejection is still an error, and carries no data', async () => {
  const r = await runSource('T', async () => { throw new Error('kaboom'); });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'kaboom');
  assert.equal(r.data, undefined);
});
