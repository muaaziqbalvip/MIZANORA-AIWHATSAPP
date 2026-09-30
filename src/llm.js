// Multi-provider LLM router.
// Every provider is called through the OpenAI-compatible /chat/completions API.
// Behaviour: rotate keys inside a provider on 429/401, fail over to the next provider on
// outages, retry once without tools if a model rejects function-calling.
import { PROVIDERS, keysFor, enabledProviders, modelLadder } from './config.js';
import { log, warn } from './log.js';

const cooldowns = new Map();   // "provider:keyIndex" or "provider" -> until (ms epoch)
const rr = new Map();          // provider -> next key index (round robin)

const cooling = (k) => (cooldowns.get(k) || 0) > Date.now();
const cool = (k, ms) => cooldowns.set(k, Date.now() + ms);

async function post(url, key, body, timeoutMs = 60000) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw Object.assign(new Error(`network: ${e.message}`), { status: 0 });
  }
  const text = await res.text();
  if (!res.ok) {
    const retryAfter = parseFloat(res.headers.get('retry-after') || '0') * 1000;
    throw Object.assign(new Error(`${res.status} ${text.slice(0, 300)}`), { status: res.status, retryAfter });
  }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid JSON from provider'), { status: 502 }); }
}

const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/**
 * chat({ messages, tools, vision, temperature, maxTokens })
 * → { message: {role, content, tool_calls?}, provider, model }
 *
 * Ladder: provider → model (comma-separated ladder, e.g. Gemini's) → key.
 * 429 on a model/key → next key, then next model (Gemini quotas are per model), then next provider.
 */
export async function chat({ messages, tools = null, vision = false, temperature = 0.6, maxTokens = 1500 }) {
  const order = enabledProviders({ vision });
  if (!order.length) throw new Error(vision ? 'No vision-capable provider configured (set GEMINI/GROQ/OPENAI key).' : 'No LLM provider configured — add at least one API key in GitHub secrets.');
  const errors = [];

  for (const id of order) {
    if (cooling(id)) { errors.push(`${id}: cooling down`); continue; }
    const p = PROVIDERS[id];
    const models = modelLadder(vision ? p.visionModel : p.model);
    const keys = p.keyless ? [''] : keysFor(id);
    const start = (rr.get(id) || 0) % keys.length;

    for (const model of models) {
      if (cooling(`${id}/${model}`)) { errors.push(`${id}/${model}: cooling`); continue; }
      let modelDead = false;

      for (let n = 0; n < keys.length && !modelDead; n++) {
        const ki = (start + n) % keys.length;
        const ckey = `${id}/${model}#${ki}`;
        if (cooling(ckey)) continue;
        const body = { model, messages, temperature, max_tokens: maxTokens };
        if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

        try {
          let data;
          try {
            data = await post(`${p.base}/chat/completions`, keys[ki], body);
          } catch (e) {
            // Model can't do tools / produced malformed tool call → retry same key without tools once.
            if (e.status === 400 && body.tools) {
              delete body.tools; delete body.tool_choice;
              data = await post(`${p.base}/chat/completions`, keys[ki], body);
            } else throw e;
          }
          const msg = data?.choices?.[0]?.message;
          if (!msg) throw Object.assign(new Error('empty response'), { status: 502 });
          rr.set(id, (ki + 1) % keys.length);
          msg.content = stripThink(msg.content);
          return { message: msg, provider: id, model };
        } catch (e) {
          errors.push(`${id}/${model}#${ki}: ${e.message.slice(0, 110)}`);
          if (e.status === 429) cool(ckey, Math.min(Math.max(e.retryAfter || 0, 30000), 300000));   // try next key, then next model
          else if (e.status === 401 || e.status === 403) cool(ckey, 3600000);                        // bad key → next key
          else if (e.status === 404) { cool(`${id}/${model}`, 3600000); modelDead = true; }          // unknown model → next model
          else if (e.status === 400) { modelDead = true; }                                           // request rejected → next model
          else { cool(`${id}/${model}`, 20000); modelDead = true; }                                  // 5xx / timeout / network → next model (Mark-LIV: -latest aliases 504)
        }
      }
    }
  }
  warn('All LLM providers failed:', errors.join(' | '));
  throw new Error('All AI providers are busy or failing right now. ' + errors.slice(-3).join(' | '));
}

/** Convenience for one-shot text generation (no tools). */
export async function complete(system, user, opts = {}) {
  const { message, provider } = await chat({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: opts.temperature ?? 0.3, maxTokens: opts.maxTokens ?? 800,
  });
  log(`complete() via ${provider}`);
  return message.content || '';
}

export function providerStatus() {
  return enabledProviders().map((id) => ({ id, keys: PROVIDERS[id].keyless ? 'local' : keysFor(id).length, model: modelLadder(PROVIDERS[id].model).join(' > '), cooling: cooling(id) }));
}
