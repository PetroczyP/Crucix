// safeFetch — unit tests
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch, ago, today, daysAgo, computeRetryDelay, MIN_RETRY_DELAY_MS, MAX_BACKOFF_MS } from '../apis/utils/fetch.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────

function mockResponse(status, body, headers = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  });
}

function mockNetworkError(message = 'fetch failed') {
  return Promise.reject(new Error(message));
}

// ─── safeFetch ────────────────────────────────────────────────────────────

describe('safeFetch', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return parsed JSON on success', async () => {
    globalThis.fetch = mock.fn(() => mockResponse(200, { foo: 'bar' }));
    const result = await safeFetch('https://example.com/api');
    assert.deepEqual(result, { foo: 'bar' });
  });

  it('should return rawText wrapper when response is not JSON', async () => {
    globalThis.fetch = mock.fn(() => mockResponse(200, 'plain text'));
    const result = await safeFetch('https://example.com/api');
    assert.equal(typeof result.rawText, 'string');
    assert.ok(result.rawText.startsWith('plain'));
  });

  it('should return error for non-retryable 4xx without retrying', async () => {
    const fn = mock.fn(() => mockResponse(404, 'Not Found'));
    globalThis.fetch = fn;
    const result = await safeFetch('https://example.com/api', { retries: 2 });
    assert.ok(result.error);
    assert.match(result.error, /HTTP 404/);
    // Should only have been called once — no retry for 404
    assert.equal(fn.mock.callCount(), 1);
  });

  it('should return error for 400 without retrying', async () => {
    const fn = mock.fn(() => mockResponse(400, 'Bad Request'));
    globalThis.fetch = fn;
    const result = await safeFetch('https://example.com/api', { retries: 2 });
    assert.ok(result.error);
    assert.match(result.error, /HTTP 400/);
    assert.equal(fn.mock.callCount(), 1);
  });

  it('should retry on 429 and succeed on retry', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(() => {
      callCount++;
      if (callCount === 1) return mockResponse(429, 'Too Many Requests', { 'Retry-After': '1' });
      return mockResponse(200, { ok: true });
    });
    const result = await safeFetch('https://example.com/api', { retries: 2 });
    assert.deepEqual(result, { ok: true });
    assert.equal(callCount, 2);
  });

  it('should retry on 503 and succeed on retry', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(() => {
      callCount++;
      if (callCount === 1) return mockResponse(503, 'Service Unavailable');
      return mockResponse(200, { ok: true });
    });
    const result = await safeFetch('https://example.com/api', { retries: 1 });
    assert.deepEqual(result, { ok: true });
    assert.equal(callCount, 2);
  });

  it('should respect Retry-After header on 429', async () => {
    const fn = mock.fn(() => mockResponse(429, 'Rate limited', { 'Retry-After': '2' }));
    globalThis.fetch = fn;
    const start = Date.now();
    await safeFetch('https://example.com/api', { retries: 1 });
    const elapsed = Date.now() - start;
    // Should have waited at least ~2s for the Retry-After
    assert.ok(elapsed >= 1800, `Expected >=1800ms delay, got ${elapsed}ms`);
  });

  it('should return error after exhausting retries on 429', async () => {
    const fn = mock.fn(() => mockResponse(429, 'Too Many Requests', { 'Retry-After': '1' }));
    globalThis.fetch = fn;
    const result = await safeFetch('https://example.com/api', { retries: 1 });
    assert.ok(result.error);
    assert.match(result.error, /429/);
    // Called once initially + 1 retry = 2 total
    assert.equal(fn.mock.callCount(), 2);
  });

  it('should retry on network error', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(() => {
      callCount++;
      if (callCount === 1) return mockNetworkError('ECONNRESET');
      return mockResponse(200, { ok: true });
    });
    const result = await safeFetch('https://example.com/api', { retries: 1, timeout: 5000 });
    assert.deepEqual(result, { ok: true });
    assert.equal(callCount, 2);
  });

  it('should time out after specified timeout', async () => {
    globalThis.fetch = mock.fn((url, opts) => {
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new DOMException('The operation was aborted', 'AbortError');
          reject(err);
        });
      });
    });
    const result = await safeFetch('https://example.com/api', { timeout: 50, retries: 0 });
    assert.ok(result.error);
    assert.match(result.error, /timed out/i);
  });

  it('should use custom headers', async () => {
    let usedHeaders;
    globalThis.fetch = mock.fn((url, opts) => {
      usedHeaders = opts.headers;
      return mockResponse(200, {});
    });
    await safeFetch('https://example.com/api', { headers: { 'X-Custom': 'test' } });
    assert.equal(usedHeaders['X-Custom'], 'test');
    assert.equal(usedHeaders['User-Agent'], 'Crucix/1.0');
  });

  it('should send POST body when method is POST', async () => {
    let sentBody;
    globalThis.fetch = mock.fn((url, opts) => {
      sentBody = opts.body;
      return mockResponse(200, {});
    });
    await safeFetch('https://example.com/api', { method: 'POST', body: { key: 'value' } });
    assert.equal(sentBody, JSON.stringify({ key: 'value' }));
  });

  it('should not retry on 403 Forbidden', async () => {
    const fn = mock.fn(() => mockResponse(403, 'Forbidden'));
    globalThis.fetch = fn;
    const result = await safeFetch('https://example.com/api', { retries: 3 });
    assert.ok(result.error);
    assert.match(result.error, /HTTP 403/);
    assert.equal(fn.mock.callCount(), 1);
  });

  it('should retry on 408 Request Timeout', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(() => {
      callCount++;
      if (callCount === 1) return mockResponse(408, 'Request Timeout');
      return mockResponse(200, { ok: true });
    });
    const result = await safeFetch('https://example.com/api', { retries: 1 });
    assert.deepEqual(result, { ok: true });
    assert.equal(callCount, 2);
  });

  it('should not exceed max backoff when Retry-After is excessive', async () => {
    const fn = mock.fn(() => mockResponse(429, 'Rate limited', { 'Retry-After': '300' }));
    globalThis.fetch = fn;
    const start = Date.now();
    await safeFetch('https://example.com/api', { retries: 1 });
    const elapsed = Date.now() - start;
    // Should have capped at MAX_RETRY_AFTER_SEC=60s, but with only 1 retry
    // and max total backoff of 30s, it should be well under 300s
    assert.ok(elapsed < 120000, `Expected <120s, got ${elapsed}ms`);
  });
});

// ─── date helpers ─────────────────────────────────────────────────────────

describe('date helpers', () => {
  it('ago should return ISO string in the past', () => {
    const result = ago(1);
    const diff = Date.now() - new Date(result).getTime();
    assert.ok(diff > 3_500_000 && diff < 3_700_000, `Expected ~1h ago, got ${diff}ms`);
  });

  it('today should return YYYY-MM-DD', () => {
    const result = today();
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('daysAgo should return YYYY-MM-DD in the past', () => {
    const result = daysAgo(5);
    const diff = Date.now() - new Date(result).getTime();
    assert.ok(diff > 4 * 86_400_000 && diff < 6 * 86_400_000, `Expected ~5 days ago, got ${diff}ms`);
  });
});

// ─── Retry-delay clamp (project-authored) ─────────────────────────────────
//
// PR #121 computes `waitMs = Math.min(desired, MAX_BACKOFF_MS - totalBackoff)`
// and then guards `if (waitMs > 0)`. Once the accumulated backoff reaches the
// ceiling that expression is <= 0, the guard is false, and the retry fires with
// NO delay at all — against an endpoint that is already rate-limiting us.
// PR #121's own 18 cases never reach that boundary.

describe('computeRetryDelay — backoff ceiling', () => {
  it('returns the desired delay when well under the ceiling', () => {
    assert.equal(computeRetryDelay(2_000, 0), 2_000);
  });

  it('clamps to the remaining budget as the ceiling is approached', () => {
    assert.equal(computeRetryDelay(10_000, MAX_BACKOFF_MS - 5_000), 5_000);
  });

  it('never returns zero at the ceiling — the defect this guards', () => {
    assert.equal(computeRetryDelay(10_000, MAX_BACKOFF_MS), MIN_RETRY_DELAY_MS);
  });

  it('never returns a negative delay past the ceiling', () => {
    assert.ok(computeRetryDelay(10_000, MAX_BACKOFF_MS + 10_000) >= MIN_RETRY_DELAY_MS);
  });

  it('floors a sub-minimum remaining budget rather than skipping the wait', () => {
    assert.equal(computeRetryDelay(10_000, MAX_BACKOFF_MS - 1), MIN_RETRY_DELAY_MS);
  });
});

// ─── Long Retry-After must not be retried (project-authored) ──────────────
//
// Live OpenSky returns HTTP 429 with `x-rate-limit-retry-after-seconds: 20934`
// (~5.8h) once the anonymous quota is spent. Two defects followed:
//   1. only standard `Retry-After` was read, so the vendor header was ignored
//      and the request fell through to exponential backoff and retried anyway;
//   2. a standard header was silently capped 20934s -> 60s, so we waited 30s
//      (the whole backoff budget) and retried a server that said "6 hours".
// Both burn credits against a metered API and stall every sweep by 30s.

describe('safeFetch — retry-after longer than we can honour', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('does not retry when standard Retry-After exceeds the max wait', async () => {
    const f = mock.fn(() => mockResponse(429, 'rate limited', { 'Retry-After': '20934' }));
    globalThis.fetch = f;
    const t0 = Date.now();
    const r = await safeFetch('https://example.com/api', { retries: 2 });
    assert.equal(f.mock.callCount(), 1, 'must not retry');
    assert.ok(String(r.error).includes('429'));
    assert.ok(Date.now() - t0 < 1000, 'must not sit in backoff');
  });

  it('honours the vendor x-rate-limit-retry-after-seconds header', async () => {
    const f = mock.fn(() => mockResponse(429, 'rate limited', { 'x-rate-limit-retry-after-seconds': '20934' }));
    globalThis.fetch = f;
    const r = await safeFetch('https://example.com/api', { retries: 2 });
    assert.equal(f.mock.callCount(), 1, 'vendor header must be honoured');
    assert.ok(String(r.error).includes('429'));
  });

  // H-3: the honourable window is the remaining backoff budget (30s), not
  // MAX_RETRY_AFTER_SEC (60s). 31-60s previously slipped through, waited the
  // full 30s and retried early.
  for (const [sec, shouldRetry] of [[29, true], [30, true], [31, false], [60, false], [61, false]]) {
    it(`Retry-After ${sec}s ${shouldRetry ? 'retries' : 'does NOT retry'}`, async () => {
      let n = 0;
      globalThis.fetch = mock.fn(() => (++n === 1
        ? mockResponse(429, 'slow down', { 'Retry-After': String(sec) })
        : mockResponse(200, { ok: true })));
      const r = await safeFetch('https://example.com/api', { retries: 2, });
      if (shouldRetry) assert.ok(n > 1, `expected a retry for ${sec}s`);
      else { assert.equal(n, 1, `expected no retry for ${sec}s`); assert.ok(String(r.error).includes('429')); }
    });
  }

  it('still retries when Retry-After is within the max wait', async () => {
    let n = 0;
    globalThis.fetch = mock.fn(() => (++n === 1
      ? mockResponse(429, 'slow down', { 'Retry-After': '1' })
      : mockResponse(200, { ok: true })));
    const r = await safeFetch('https://example.com/api', { retries: 2 });
    assert.deepEqual(r, { ok: true });
    assert.equal(n, 2);
  });
});
