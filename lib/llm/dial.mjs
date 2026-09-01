// DIAL Provider — raw fetch, no SDK
//
// EPAM DIAL is a self-hosted AI gateway exposing many upstream providers
// (Azure OpenAI, Anthropic, Google, DeepSeek, Meta …) behind one
// Azure-OpenAI-compatible REST API. The deployment name IS the model id, so
// `LLM_MODEL` selects both the provider and the model — e.g. `gpt-4.1-nano-2025-04-14`
// or `claude-opus-4-5@20251101` are both valid values for the same key.
//
// Two things differ from the OpenAI provider and are the whole reason this file exists:
//   1. Auth is the `Api-Key` header, NOT `Authorization: Bearer`.
//   2. The model goes in the URL path, not the body, and `api-version` is a
//      REQUIRED query parameter (format YYYY-MM-DD[-preview]).
//
// There is deliberately NO default baseUrl. DIAL is self-hosted: every
// organisation runs its own instance on its own (often internal, VPN-only)
// hostname, so a baked-in default would be wrong for everyone except one org
// and would leak that org's internal hostname into the repo. Absent a
// configured base URL the provider reports itself unconfigured.

import { LLMProvider } from './provider.mjs';

const DEFAULT_API_VERSION = '2024-10-21';

export class DialProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name = 'dial';
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
    // No default deployment: what a key can reach is instance- and key-specific.
    // GET {baseUrl}/openai/deployments lists what this key may use.
    this.model = config.model || null;
  }

  get isConfigured() { return !!(this.apiKey && this.baseUrl && this.model); }

  async complete(systemPrompt, userMessage, opts = {}) {
    if (!this.baseUrl) throw new Error('DIAL: baseUrl is required (set DIAL_BASE_URL)');
    if (!this.model) throw new Error('DIAL: model/deployment is required (set LLM_MODEL)');

    const url = `${this.baseUrl}/openai/deployments/${encodeURIComponent(this.model)}`
      + `/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': this.apiKey,
      },
      body: JSON.stringify({
        max_tokens: opts.maxTokens || 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`DIAL API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model || this.model,
    };
  }

  /**
   * List the deployments this key can reach. Not part of the LLMProvider
   * contract — DIAL-specific, and the reason a wrong `LLM_MODEL` is
   * diagnosable rather than a guess.
   * @returns {Promise<string[]>} deployment ids
   */
  async listDeployments(opts = {}) {
    if (!this.apiKey || !this.baseUrl) throw new Error('DIAL: apiKey and baseUrl are required');
    const url = `${this.baseUrl}/openai/deployments?api-version=${encodeURIComponent(this.apiVersion)}`;
    const res = await fetch(url, {
      headers: { 'Api-Key': this.apiKey },
      signal: AbortSignal.timeout(opts.timeout || 30000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`DIAL API ${res.status}: ${err.substring(0, 200)}`);
    }
    const data = await res.json();
    const list = data.data || data.deployments || (Array.isArray(data) ? data : []);
    return list.map(d => d.id || d.model || d.name).filter(Boolean);
  }
}
