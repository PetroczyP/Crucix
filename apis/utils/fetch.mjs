// Shared fetch utility with timeout, retries, exponential backoff, and HTTP 429 handling

// HTTP status codes that are safe to retry
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Maximum total backoff across all retries (30s)
export const MAX_BACKOFF_MS = 30_000;

// Floor for any retry delay. Once the accumulated backoff reaches the ceiling,
// the remaining budget is <= 0; retrying with no delay at all against an
// endpoint that is already rate-limiting us is worse than exceeding the budget
// slightly, so the floor takes precedence over the ceiling.
export const MIN_RETRY_DELAY_MS = 250;

/**
 * Delay before the next retry: the desired wait, clamped to the remaining
 * backoff budget, but never below MIN_RETRY_DELAY_MS.
 * @param {number} desiredMs     - the wait this attempt would like
 * @param {number} totalBackoff  - backoff already consumed
 * @returns {number} a strictly positive delay in ms
 */
export function computeRetryDelay(desiredMs, totalBackoff) {
  const remaining = MAX_BACKOFF_MS - totalBackoff;
  return Math.max(Math.min(desiredMs, remaining), MIN_RETRY_DELAY_MS);
}

// Base delay for exponential backoff (100ms)
const BASE_DELAY_MS = 100;

// Cap on how long we'll wait for a Retry-After header (60s)
const MAX_RETRY_AFTER_SEC = 60;

function isRetryable(status) {
  return RETRYABLE_STATUSES.has(status);
}

// Reads the server's requested wait, UNCAPPED, from the standard header or a
// known vendor equivalent. Returns null when absent/unparseable.
// OpenSky sends `x-rate-limit-retry-after-seconds`, not `Retry-After`, so
// reading only the standard header made a 6-hour cool-off invisible.
function parseRetryAfterSeconds(res) {
  for (const name of ['Retry-After', 'x-rate-limit-retry-after-seconds']) {
    const header = res.headers?.get(name);
    if (!header) continue;
    const seconds = parseInt(header, 10);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  // Retry-After can also be an HTTP-date, but that's rare in practice.
  return null;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch a URL with timeout, retries, exponential backoff, and HTTP 429 awareness.
 *
 * @param {string} url          - The URL to fetch
 * @param {object} [opts]       - Options
 * @param {number} [opts.timeout=15000]  - Per-request timeout in ms
 * @param {number} [opts.retries=1]      - Number of retry attempts (0 = try once, no retry)
 * @param {object} [opts.headers={}]     - Extra request headers
 * @param {string} [opts.method='GET']   - HTTP method
 * @param {*}      [opts.body]           - Request body (for POST/PUT)
 * @returns {Promise<object>} Parsed JSON, or `{ error, source }` on failure
 */
export async function safeFetch(url, opts = {}) {
  const { timeout = 15000, retries = 1, headers = {}, method = 'GET', body } = opts;
  let lastError;
  let totalBackoff = 0;

  for (let i = 0; i <= retries; i++) {
    const isLastAttempt = i === retries;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOpts = {
        signal: controller.signal,
        method,
        headers: { 'User-Agent': 'Crucix/1.0', ...headers },
      };
      if (body && method !== 'GET') {
        fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);

      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { rawText: text.slice(0, 500) }; }
      }

      // Non-retryable client error — bail immediately
      if (!isRetryable(res.status)) {
        const errBody = await res.text().catch(() => '');
        return { error: `HTTP ${res.status}: ${errBody.slice(0, 200)}`, source: url };
      }

      // Retryable — check how long the server wants us to wait.
      // If that exceeds what we can honour, retrying is pure waste: it burns
      // quota against a metered API and stalls the sweep for the whole backoff
      // budget, and it will fail again anyway. Give up now and report it.
      // The threshold is the budget we can ACTUALLY honour, which is the
      // remaining backoff allowance (<= 30s), not MAX_RETRY_AFTER_SEC (60s).
      // Using 60 meant a server asking 31-60s skipped this path, waited the
      // whole 30s budget and retried early anyway — the very quota burn this
      // guard exists to stop.
      const retryAfter = parseRetryAfterSeconds(res);
      const honourableSec = Math.min(MAX_RETRY_AFTER_SEC, Math.max(0, MAX_BACKOFF_MS - totalBackoff) / 1000);
      if (retryAfter !== null && retryAfter > honourableSec) {
        return {
          error: `HTTP ${res.status}: server asked for ${retryAfter}s (> ${honourableSec}s we can honour) — not retrying`,
          source: url,
          retryAfterSeconds: retryAfter,
        };
      }
      if (retryAfter !== null && !isLastAttempt) {
        const waitMs = computeRetryDelay(retryAfter * 1000, totalBackoff);
        totalBackoff += waitMs;
        await delay(waitMs);
        continue;
      }

      throw new Error(`HTTP ${res.status}`);

    } catch (e) {
      clearTimeout(timer);

      if (e.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${timeout}ms`);
      } else {
        lastError = e;
      }

      if (!isLastAttempt) {
        // Exponential backoff with jitter: base * 2^i + random(0, 1000)
        const baseBackoff = Math.min(BASE_DELAY_MS * Math.pow(2, i), MAX_BACKOFF_MS);
        const jitter = Math.round(Math.random() * 1000);
        const waitMs = computeRetryDelay(baseBackoff + jitter, totalBackoff);
        totalBackoff += waitMs;
        await delay(waitMs);
      }
    }
  }

  return { error: lastError?.message || 'Unknown error', source: url };
}

export function ago(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

export function today() {
  return new Date().toISOString().split('T')[0];
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
