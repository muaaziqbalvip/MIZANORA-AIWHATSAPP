// Central configuration — everything comes from environment variables / .env
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader (no dependency). Real environment variables always win.
(function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
  }
})();

export const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
export const envInt = (k, d) => { const n = parseInt(env(k, ''), 10); return Number.isFinite(n) ? n : d; };
export const envBool = (k, d = false) => { const v = env(k, ''); return v === '' ? d : /^(1|true|yes|on)$/i.test(v); };
export const list = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
export const digits = (s) => String(s || '').replace(/\D/g, '');

export const BOT = {
  name: env('BOT_NAME', 'Mizanora'),
  developer: 'Muaaz Iqbal',
};

const memoryDir = path.resolve(ROOT, env('MEMORY_DIR', 'memory_store'));
export const PATHS = {
  memoryDir,
  authDir: path.join(memoryDir, 'wa_auth'),
  memoryFile: path.join(memoryDir, 'bot_memory.json'),
  workspace: path.resolve(ROOT, env('WORKSPACE_DIR', 'workspace')),
};
for (const d of [PATHS.memoryDir, PATHS.authDir, PATHS.workspace]) fs.mkdirSync(d, { recursive: true });

export const ACCESS = {
  owners: list(env('OWNER_NUMBERS')).map(digits).filter(Boolean),     // full control: code exec, group admin anywhere
  allowed: list(env('ALLOWED_NUMBERS')).map(digits).filter(Boolean),  // if non-empty: only these (+owners) may use the bot in DMs
  groupTrigger: env('GROUP_TRIGGER', BOT.name.toLowerCase()),         // word that wakes the bot in groups (besides @mention / reply)
  rateLimitPerMin: envInt('RATE_LIMIT_PER_MIN', 12),
  pairNumber: digits(env('PAIR_NUMBER')),
};

export const RUNTIME = {
  maxRuntimeMin: envInt('MAX_RUNTIME_MIN', 0), // 0 = unlimited (local). On GitHub Actions use ~340.
  saveEverySec: envInt('SAVE_EVERY_SEC', 30),
};

// ── LLM providers: ALL speak the OpenAI-compatible chat API ─────────────────────────
// Each provider may have several keys: GROQ_API_KEYS="k1,k2,k3" (or a single GROQ_API_KEY).
// Keys rotate automatically on rate limits; providers fail over in LLM_PROVIDER_ORDER.
// MODEL env vars accept a comma-separated ladder: "model-a,model-b" — tried left to right.
const P = (id, base, model, visionModel = '', extraKeyEnv = []) => ({
  id, base,
  model: env(`${id.toUpperCase()}_MODEL`, model),
  visionModel: env(`${id.toUpperCase()}_VISION_MODEL`, visionModel),
  extraKeyEnv,
});
export const modelLadder = (s) => list(s);

export const PROVIDERS = {
  groq: P('groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'),
  // Mark-LIV's exact REST ladder first (core/gemini.py). Google has deprecated the 2.5 models (new API keys may get 404),
  // so the router skips dead rungs automatically and the currently-served gemini-3.5-flash / 3.1-flash-lite sit at the end.
  gemini: P('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai',
    'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-flash-latest,gemini-flash-lite-latest,gemini-3.5-flash,gemini-3.1-flash-lite',
    'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-flash-latest,gemini-3.5-flash', ['GOOGLE_API_KEY']),
  openrouter: P('openrouter', 'https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct:free', ''),
  cerebras: P('cerebras', 'https://api.cerebras.ai/v1', 'llama-3.3-70b'),
  mistral: P('mistral', 'https://api.mistral.ai/v1', 'mistral-small-latest', 'mistral-small-latest'),
  deepseek: P('deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat'),
  together: P('together', 'https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'),
  openai: P('openai', 'https://api.openai.com/v1', 'gpt-4o-mini', 'gpt-4o-mini'),
  custom: { id: 'custom', base: env('CUSTOM_BASE_URL').replace(/\/+$/, ''), model: env('CUSTOM_MODEL'), visionModel: env('CUSTOM_VISION_MODEL'), extraKeyEnv: [] },
  ollama: { id: 'ollama', base: env('OLLAMA_URL') ? env('OLLAMA_URL').replace(/\/+$/, '') + '/v1' : '', model: env('OLLAMA_MODEL', 'llama3.2'), visionModel: env('OLLAMA_VISION_MODEL'), extraKeyEnv: [], keyless: true },
};

export function keysFor(id) {
  const up = id.toUpperCase();
  const names = [`${up}_API_KEYS`, `${up}_API_KEY`, ...(PROVIDERS[id]?.extraKeyEnv || [])];
  return [...new Set(names.flatMap((n) => list(env(n))))];
}

export const PROVIDER_ORDER = list(env('LLM_PROVIDER_ORDER', 'gemini,groq,openrouter,cerebras,mistral,deepseek,together,openai,custom,ollama'))
  .filter((id) => PROVIDERS[id]);

export function enabledProviders({ vision = false } = {}) {
  return PROVIDER_ORDER.filter((id) => {
    const p = PROVIDERS[id];
    if (!p.base || !p.model) return false;
    if (vision && !p.visionModel) return false;
    return p.keyless ? true : keysFor(id).length > 0;
  });
}

export const VOICE = {
  sttOrder: list(env('STT_PROVIDER_ORDER', 'gemini,groq,openai')),
  sttGroqModel: env('STT_GROQ_MODEL', 'whisper-large-v3-turbo'),
  ttsVoices: {
    ur: env('TTS_VOICE_UR', 'ur-PK-UzmaNeural'),
    hi: env('TTS_VOICE_HI', 'hi-IN-SwaraNeural'),
    en: env('TTS_VOICE_EN', 'en-US-AriaNeural'),
  },
  ttsRate: env('TTS_RATE', '+0%'),
  sendTextWithVoice: envBool('SEND_TEXT_WITH_VOICE', false),
};

export const IMAGE_ORDER = list(env('IMAGE_PROVIDER_ORDER', 'pollinations,huggingface,together,openai'));

// Grounded web search (Gemini google_search tool) — same ladder as Mark-LIV actions/web_search.py
export const GEMINI_SEARCH_MODELS = list(env('GEMINI_SEARCH_MODELS', 'gemini-2.5-flash,gemini-flash-latest,gemini-2.5-flash-lite,gemini-3.5-flash'));
export const GEMINI_STT_MODELS = list(env('STT_GEMINI_MODEL', 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-flash-latest,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite'));

// ── WhatsApp transport ──────────────────────────────────────────────────────────────
// 'agent'   = Meta's official WhatsApp Agent Platform API (Settings → Agents → your agent → Chat info → API key).
//             No pairing, no phone linking, no ban risk. Only the agent's creator can chat (Meta beta rule).
// 'baileys' = unofficial WhatsApp Web client (needs pairing; supports groups / many users; ban risk).
export const AGENT = {
  apiKey: env('WHATSAPP_AGENT_API_KEY'),
  baseUrl: env('WHATSAPP_AGENT_BASE_URL', 'https://api.whatsapp.com/agent/v1').replace(/\/+$/, ''),
  pollTimeout: Math.min(Math.max(envInt('AGENT_POLL_TIMEOUT', 20), 0), 25),
  maxAgeMin: envInt('AGENT_MAX_AGE_MIN', 60),
};
export const WA_MODE = (env('WA_MODE', AGENT.apiKey ? 'agent' : 'baileys')).toLowerCase() === 'baileys' ? 'baileys' : 'agent';
