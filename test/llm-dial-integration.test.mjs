// DIAL provider — integration test (calls the real gateway)
// Requires DIAL_API_KEY and DIAL_BASE_URL environment variables.
// Run: DIAL_API_KEY=dial-... DIAL_BASE_URL=https://your-instance node --test test/llm-dial-integration.test.mjs
//
// Skipped unless BOTH are set — DIAL is self-hosted and usually reachable only
// from inside the owning organisation's network, so there is no host this can
// fall back to.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DialProvider } from '../lib/llm/dial.mjs';

const API_KEY = process.env.DIAL_API_KEY;
const BASE_URL = process.env.DIAL_BASE_URL;
const MODEL = process.env.DIAL_TEST_MODEL || 'gpt-4.1-nano-2025-04-14';

const skip = !API_KEY ? 'DIAL_API_KEY not set'
  : !BASE_URL ? 'DIAL_BASE_URL not set'
  : false;

describe('DIAL integration', { skip }, () => {
  it('lists deployments this key can reach', async () => {
    const provider = new DialProvider({ apiKey: API_KEY, baseUrl: BASE_URL });
    const ids = await provider.listDeployments({ timeout: 30000 });
    assert.ok(Array.isArray(ids) && ids.length > 0, 'expected at least one deployment');
    assert.ok(ids.every(i => typeof i === 'string' && i.length > 0), 'every deployment id is a non-empty string');
  });

  it('completes a prompt through the configured deployment', async () => {
    const provider = new DialProvider({ apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL });
    assert.equal(provider.isConfigured, true);

    const result = await provider.complete(
      'You are a test harness. Reply with exactly the text the user asks for, nothing else.',
      'Reply with exactly: DIAL test OK',
      { maxTokens: 20, timeout: 60000 },
    );

    assert.ok(result.text.includes('DIAL test OK'), `unexpected content: ${JSON.stringify(result.text)}`);
    assert.ok(result.usage.inputTokens > 0, 'prompt tokens should be reported');
    assert.ok(result.usage.outputTokens > 0, 'completion tokens should be reported');
    assert.equal(typeof result.model, 'string');
  });

  it('rejects a bad key with a 401 rather than failing open', async () => {
    const provider = new DialProvider({ apiKey: 'definitely-not-a-real-key', baseUrl: BASE_URL, model: MODEL });
    await assert.rejects(
      () => provider.complete('sys', 'user', { timeout: 30000 }),
      (err) => { assert.match(err.message, /DIAL API 4\d\d/); return true; },
    );
  });
});
