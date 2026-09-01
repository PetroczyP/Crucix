// Crucix Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first

// Security: validate PORT is numeric and in a safe range
function validatePort(val) {
  // parseInt() accepts prefixes, so '1024abc', '1024.5' and '0x400' all yield
  // 1024 — which contradicts "validate PORT is numeric". Require the whole
  // trimmed string to be a decimal integer.
  const str = String(val ?? '').trim();
  const port = /^\d+$/.test(str) ? Number(str) : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    if (val !== undefined && str !== '') {
      console.warn(`[Crucix] Invalid PORT "${val}", using default 3117`);
    }
    return 3117;
  }
  return port;
}

export default {
  port: validatePort(process.env.PORT),
  publicUrl: process.env.PUBLIC_URL || null,
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 15,

  llm: {
    provider: process.env.LLM_PROVIDER || null, // anthropic | openai | gemini | codex | openrouter | minimax | mistral | ollama | grok | dial
    // DIAL_API_KEY is accepted as a fallback so an existing DIAL credential works
    // without duplicating it into LLM_API_KEY.
    apiKey: process.env.LLM_API_KEY || process.env.DIAL_API_KEY || null,
    model: process.env.LLM_MODEL || null,
    baseUrl: process.env.OLLAMA_BASE_URL || null,
    // DIAL is self-hosted — no default host exists, so this is required for provider=dial
    dialBaseUrl: process.env.DIAL_BASE_URL || null,
    dialApiVersion: process.env.DIAL_API_VERSION || null,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    botPollingInterval: parseInt(process.env.TELEGRAM_POLL_INTERVAL) || 5000,
    channels: process.env.TELEGRAM_CHANNELS || null, // Comma-separated extra channel IDs
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null, // Server ID (for instant slash command registration)
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null, // Fallback: webhook-only alerts (no bot needed)
  },

  // Delta engine thresholds — override defaults from lib/delta/engine.mjs
  // Set to null to use built-in defaults
  delta: {
    thresholds: {
      numeric: {
        // Example overrides (uncomment to customize):
        // vix: 3,       // more sensitive to VIX moves
        // wti: 5,       // less sensitive to oil moves
      },
      count: {
        // urgent_posts: 3,     // need ±3 urgent posts to flag
        // thermal_total: 1000, // need ±1000 thermal detections
      },
    },
  },
};
