// DIAL provider — unit tests
// Uses Node.js built-in test runner (node:test) — no extra dependencies
//
// DIAL differs from every other provider here in three ways, and each one is
// asserted rather than assumed, because each is a way the request can be
// silently wrong while still looking like a valid OpenAI call:
//   1. auth is `Api-Key`, not `Authorization: Bearer`
//   2. the deployment goes in the URL PATH, not the body
//   3. `api-version` is a REQUIRED query parameter

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DialProvider } from '../lib/llm/dial.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';

const BASE = 'https://dial.example.test';
const OK_BODY = {
  choices: [{ message: { content: 'DIAL test OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 15, completion_tokens: 5 },
  model: 'gpt-4.1-nano-2025-04-14',
};

/** Capture the single fetch call the provider makes. */
function captureFetch(response = { ok: true, status: 200, json: () => Promise.resolve(OK_BODY) }) {
  const calls = [];
  const fn = mock.fn((url, init) => { calls.push({ url, init }); return Promise.resolve(response); });
  return { fn, calls };
}

async function withFetch(stub, body) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await body(); } finally { globalThis.fetch = original; }
}

describe('DialProvider — configuration', () => {
  it('names itself dial and keeps the deployment as the model id', () => {
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'gpt-4.1-nano-2025-04-14' });
    assert.equal(p.name, 'dial');
    assert.equal(p.model, 'gpt-4.1-nano-2025-04-14');
    assert.equal(p.isConfigured, true);
  });

  it('defaults api-version to 2024-10-21', () => {
    assert.equal(new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'm' }).apiVersion, '2024-10-21');
  });

  it('accepts an api-version override', () => {
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'm', apiVersion: '2025-01-01-preview' });
    assert.equal(p.apiVersion, '2025-01-01-preview');
  });

  it('strips trailing slashes from baseUrl so the path never doubles up', () => {
    assert.equal(new DialProvider({ apiKey: 'k', baseUrl: `${BASE}///`, model: 'm' }).baseUrl, BASE);
  });

  // Each of the three is independently required — asserted one at a time so a
  // mutation loosening any single condition is observable.
  it('is NOT configured without an apiKey', () => {
    assert.equal(new DialProvider({ baseUrl: BASE, model: 'm' }).isConfigured, false);
  });

  it('is NOT configured without a baseUrl — DIAL is self-hosted, there is no default host', () => {
    assert.equal(new DialProvider({ apiKey: 'k', model: 'm' }).isConfigured, false);
  });

  it('is NOT configured without a model/deployment', () => {
    assert.equal(new DialProvider({ apiKey: 'k', baseUrl: BASE }).isConfigured, false);
  });

  it('has no default deployment — what a key can reach is instance-specific', () => {
    assert.equal(new DialProvider({ apiKey: 'k', baseUrl: BASE }).model, null);
  });
});

describe('DialProvider — request shape', () => {
  it('puts the deployment in the PATH and api-version in the QUERY', async () => {
    const { fn, calls } = captureFetch();
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'gpt-4.1-nano-2025-04-14' });
    await withFetch(fn, () => p.complete('sys', 'user'));
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${BASE}/openai/deployments/gpt-4.1-nano-2025-04-14/chat/completions?api-version=2024-10-21`,
    );
  });

  it('authenticates with Api-Key and NOT with Authorization: Bearer', async () => {
    const { fn, calls } = captureFetch();
    const p = new DialProvider({ apiKey: 'secret-key', baseUrl: BASE, model: 'm' });
    await withFetch(fn, () => p.complete('sys', 'user'));
    const h = calls[0].init.headers;
    assert.equal(h['Api-Key'], 'secret-key', 'DIAL authenticates with the Api-Key header');
    assert.equal(h.Authorization, undefined, 'a Bearer token would be the wrong scheme for a DIAL key');
  });

  it('URL-encodes deployment names containing @ (Anthropic/Google style)', async () => {
    const { fn, calls } = captureFetch();
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'claude-opus-4-5@20251101' });
    await withFetch(fn, () => p.complete('sys', 'user'));
    assert.ok(calls[0].url.includes('claude-opus-4-5%4020251101'),
      `deployment must be encoded in the path, got ${calls[0].url}`);
  });

  it('does NOT put the model in the body — the path selects it', async () => {
    const { fn, calls } = captureFetch();
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'm' });
    await withFetch(fn, () => p.complete('sys', 'user'));
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, undefined);
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
  });

  it('honours maxTokens', async () => {
    const { fn, calls } = captureFetch();
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'm' });
    await withFetch(fn, () => p.complete('sys', 'user', { maxTokens: 42 }));
    assert.equal(JSON.parse(calls[0].init.body).max_tokens, 42);
  });
});

describe('DialProvider — responses and failures', () => {
  it('maps the OpenAI-shaped response onto the provider contract', async () => {
    const { fn } = captureFetch();
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE, model: 'm' });
    const r = await withFetch(fn, () => p.complete('sys', 'user'));
    assert.equal(r.text, 'DIAL test OK');
    assert.deepEqual(r.usage, { inputTokens: 15, outputTokens: 5 });
    assert.equal(r.model, 'gpt-4.1-nano-2025-04-14');
  });

  it('throws with the status code on an API error', async () => {
    const { fn } = captureFetch({ ok: false, status: 401, text: () => Promise.resolve('Invalid key') });
    const p = new DialProvider({ apiKey: 'bad', baseUrl: BASE, model: 'm' });
    await withFetch(fn, () => assert.rejects(
      () => p.complete('sys', 'user'),
      (e) => { assert.match(e.message, /DIAL API 401/); return true; },
    ));
  });

  it('fails loudly rather than calling a wrong URL when baseUrl is missing', async () => {
    const p = new DialProvider({ apiKey: 'k', model: 'm' });
    await assert.rejects(() => p.complete('s', 'u'), /baseUrl is required/);
  });

  it('fails loudly when the deployment is missing', async () => {
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE });
    await assert.rejects(() => p.complete('s', 'u'), /deployment is required/);
  });

  it('lists deployments so a wrong LLM_MODEL is diagnosable, not a guess', async () => {
    const { fn, calls } = captureFetch({
      ok: true, status: 200,
      json: () => Promise.resolve({ data: [{ id: 'gpt-4o' }, { id: 'claude-opus-4-5@20251101' }] }),
    });
    const p = new DialProvider({ apiKey: 'k', baseUrl: BASE });
    const ids = await withFetch(fn, () => p.listDeployments());
    assert.deepEqual(ids, ['gpt-4o', 'claude-opus-4-5@20251101']);
    assert.equal(calls[0].url, `${BASE}/openai/deployments?api-version=2024-10-21`);
  });
});

describe('createLLMProvider — dial wiring', () => {
  it('constructs a DialProvider for provider="dial", passing baseUrl and apiVersion through', () => {
    const p = createLLMProvider({
      provider: 'dial', apiKey: 'k', model: 'gpt-4o',
      dialBaseUrl: BASE, dialApiVersion: '2025-02-02',
    });
    assert.ok(p instanceof DialProvider);
    assert.equal(p.baseUrl, BASE);
    assert.equal(p.apiVersion, '2025-02-02');
    assert.equal(p.isConfigured, true);
  });

  it('is case-insensitive on the provider name, like its siblings', () => {
    const p = createLLMProvider({ provider: 'DIAL', apiKey: 'k', model: 'm', dialBaseUrl: BASE });
    assert.ok(p instanceof DialProvider);
  });

  it('yields an unconfigured provider when dialBaseUrl is absent, rather than a silently wrong host', () => {
    const p = createLLMProvider({ provider: 'dial', apiKey: 'k', model: 'm' });
    assert.ok(p instanceof DialProvider);
    assert.equal(p.isConfigured, false);
  });
});
