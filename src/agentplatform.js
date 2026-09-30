// Transport: Meta's official WhatsApp Agent Platform API  (https://api.whatsapp.com/agent/v1)
//
//   WhatsApp → Meta ──GET /updates (long poll)──► Mizanora ──POST /messages──► Meta → WhatsApp
//
// No pairing, no phone linking, no webhook/public URL — just the agent API key
// (WhatsApp → Settings → Agents → your agent → Chat info → API key).
// Protocol facts (Meta developer manual v1 via public client libraries):
//   * 12 messages / 12 statuses / 15 polls per minute per agent (+12/min per media method)
//   * one poller per key (HTTP 409 when a second client polls)
//   * only the agent's CREATOR can chat with it; the agent can only send to the creator
//   * text ≤ 4096 chars, captions ≤ 1024; media: image 5 MB, others 16 MB
//   * agent chats are NOT end-to-end encrypted (they pass through Meta)
import { AGENT, BOT, VOICE } from './config.js';
import { mem } from './memory.js';
import { respond } from './brain.js';
import { transcribe, transcribeVideo, synthesize, detectScript } from './voice.js';
import { extractDocText, docMimeFromName } from './docs.js';
import { providerStatus } from './llm.js';
import { log, warn, err } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_ID = /^user:\S+$/;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_MEDIA = 16 * 1024 * 1024;
const TEXT_CHUNK = 4000;

// ── rate limiting (rolling 60 s window per API method) ───────────────────────────────
export class RateWindow {
  constructor(limit, windowMs = 60000) { this.limit = limit; this.windowMs = windowMs; this.stamps = []; }
  prune(now) { while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift(); }
  tryAcquire() { const n = Date.now(); this.prune(n); if (this.stamps.length >= this.limit) return false; this.stamps.push(n); return true; }
  async acquire() {
    for (;;) {
      const n = Date.now(); this.prune(n);
      if (this.stamps.length < this.limit) { this.stamps.push(n); return; }
      await sleep(Math.max(50, this.windowMs - (n - this.stamps[0]) + 5));
    }
  }
  penalize(ms) { const n = Date.now(); this.stamps = new Array(this.limit).fill(n - this.windowMs + Math.min(this.windowMs, Math.max(0, ms))); }
}

// ── errors (classified like Meta's delivery semantics) ───────────────────────────────
class ApiError extends Error {
  constructor(message, { status = 0, code = null, kind = 'rejected', retryAfter = null } = {}) {
    super(message); this.status = status; this.code = code; this.kind = kind; this.retryAfter = retryAfter;
  }
}

async function classify(res, action) {
  let code = null;
  try { const j = await res.json(); code = Number.isInteger(j?.error?.code) ? j.error.code : null; } catch { /* no body */ }
  const status = res.status;
  const retryAfter = parseFloat(res.headers.get('retry-after') || '') * 1000 || null;
  const mk = (kind, msg) => new ApiError(`${action}: ${msg} (http ${status}${code ? `, code ${code}` : ''})`, { status, code, kind, retryAfter });
  if (status === 401 || code === 190) return mk('auth', 'API key missing or malformed');
  if (status === 400 && code === 100 && action === 'updates') return mk('auth', 'API key rejected');
  if (status === 403 || code === 131005) return mk('notcreator', 'not the agent creator');
  if (status === 409 || code === 1752041) return mk('conflict', 'another client is polling this key');
  if (status === 429 || code === 130429) return mk('ratelimit', 'rate limited');
  if (status === 503) return mk('retry', 'not accepted, retry later');
  if (status >= 500) return mk('ambiguous', 'server error, outcome unknown');
  return mk('rejected', 'rejected');
}

function baseUrlOk(u) {
  try { const p = new URL(u); return p.protocol === 'https:' || (p.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(p.hostname)); } catch { return false; }
}

const MEDIA_HOST = /(^|\.)(fbsbx\.com|whatsapp\.com|whatsapp\.net|facebook\.com|fbcdn\.net)$/i;
export function mediaUrlAllowed(u) {
  try {
    const p = new URL(u); const b = new URL(AGENT.baseUrl);
    if (p.origin === b.origin) return true;                                // same API origin (also used by tests)
    return p.protocol === 'https:' && MEDIA_HOST.test(p.hostname);          // never send the API key to an unknown host
  } catch { return false; }
}

function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function chunkText(t, n = TEXT_CHUNK) {
  const out = []; let rest = String(t).trim();
  while (rest.length > n) {
    let cut = rest.lastIndexOf('\n\n', n); if (cut < n * 0.5) cut = rest.lastIndexOf('\n', n); if (cut < n * 0.5) cut = rest.lastIndexOf(' ', n); if (cut < 1) cut = n;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function parseUpdates(j) {
  if (!j || j.object !== 'whatsapp_agent_platform' || !Number.isInteger(j.next_offset) || !Array.isArray(j.entry)) throw new ApiError('updates: unexpected response shape', { kind: 'malformed' });
  const out = { nextOffset: j.next_offset, messages: [], statuses: [], contacts: [] };
  for (const e of j.entry) for (const c of (Array.isArray(e?.changes) ? e.changes : [])) {
    if (c?.field !== 'messages' || typeof c.value !== 'object' || !c.value) continue;
    for (const k of ['messages', 'statuses', 'contacts']) if (Array.isArray(c.value[k])) out[k].push(...c.value[k].filter((x) => x && typeof x === 'object'));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────
export async function createAgentPlatform({ onFatal, onOpen }) {
  if (!AGENT.apiKey) { err('WHATSAPP_AGENT_API_KEY is not set. Add your agent API key as a GitHub secret.'); onFatal?.(2); return { isOpen: () => false, stop: async () => {} }; }
  if (!baseUrlOk(AGENT.baseUrl)) { err('WHATSAPP_AGENT_BASE_URL must be https:// (or http://localhost for tests).'); onFatal?.(2); return { isOpen: () => false, stop: async () => {} }; }

  const lim = { messages: new RateWindow(12), statuses: new RateWindow(12), updates: new RateWindow(14), upload: new RateWindow(12), mediaGet: new RateWindow(12) };
  const meta = mem.data.meta;
  const nonCreators = new Set();
  const names = new Map();
  const chains = new Map();
  let running = true; let opened = false;

  async function call(method, path, { query, json, form, timeoutMs = 30000 } = {}, action = path.slice(1).split('/')[0]) {
    const url = new URL(AGENT.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${AGENT.apiKey}` };
    let body;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); } else if (form) body = form;
    let res;
    try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new ApiError(`${action}: network ${e.name}`, { kind: method === 'GET' ? 'retry' : 'ambiguous' }); }
    if (res.status >= 400) throw await classify(res, action);
    return res;
  }

  // ── receipts / typing ──
  async function markRead(wamid, typing = false) {
    if (!lim.statuses.tryAcquire()) throw new ApiError('statuses: local budget exhausted', { kind: 'ratelimit' });
    const body = { messaging_product: 'whatsapp', status: 'read', message_id: wamid };
    if (typing) body.typing_indicator = { type: 'text' };
    const res = await call('POST', '/statuses', { json: body }, 'statuses');
    const j = await res.json().catch(() => ({}));
    if (j?.success !== true) throw new ApiError('statuses: 2xx without success=true', { kind: 'malformed' });
  }

  // ── sending ──
  async function sendMessage(to, type, payload, tried = false, attempt = 0) {
    await lim.messages.acquire();
    try {
      const res = await call('POST', '/messages', { json: { messaging_product: 'whatsapp', to, type, [type]: payload }, timeoutMs: 60000 }, 'send');
      const j = await res.json().catch(() => ({}));
      return j?.messages?.[0]?.id || null;
    } catch (e) {
      if ((e.kind === 'ratelimit' || e.kind === 'retry') && attempt < 4) {
        if (e.kind === 'ratelimit') lim.messages.penalize(e.retryAfter ?? 10000); else await sleep(2000 * 2 ** attempt);
        return sendMessage(to, type, payload, tried, attempt + 1);
      }
      // some platform versions name the upload reference "media_id" instead of "id"
      if (e.status === 400 && e.code === 131009 && payload.id && !tried) {
        const { id, ...rest } = payload;
        return sendMessage(to, type, { media_id: id, ...rest }, true, attempt);
      }
      throw e;
    }
  }

  async function uploadMedia(buf, mime, filename) {
    await lim.upload.acquire();
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([buf], { type: mime }), filename);
    const res = await call('POST', '/media', { form, timeoutMs: 90000 }, 'media-upload');
    const j = await res.json().catch(() => ({}));
    const id = j?.id || j?.media_id || j?.media?.[0]?.id;
    if (!id) throw new ApiError('media-upload: response had no media id', { kind: 'malformed' });
    return id;
  }

  async function downloadMedia(id, maxBytes = MAX_MEDIA) {
    await lim.mediaGet.acquire();
    const meta1 = await (await call('GET', `/media/${encodeURIComponent(id)}`, {}, 'media-get')).json();
    if (!meta1?.url || !mediaUrlAllowed(meta1.url)) throw new Error('media URL missing or on an untrusted host');
    if (meta1.file_size && meta1.file_size > maxBytes) throw new Error(`file too large (${Math.round(meta1.file_size / 1024)} KB)`);
    const r = await fetch(meta1.url, { headers: { Authorization: `Bearer ${AGENT.apiKey}` }, signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error(`media download http ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('file too large');
    return { buffer: buf, mime: meta1.mime_type || '' };
  }

  const wa = {
    async sendText(to, text) { for (const part of chunkText(text)) await sendMessage(to, 'text', { body: part }); },
    async sendImage(to, buffer, caption = '') {
      const kind = sniffImage(buffer);
      if (!kind || buffer.length > MAX_IMAGE) return wa.sendDocument(to, buffer, `image.${kind?.ext || 'png'}`);
      const id = await uploadMedia(buffer, kind.mime, `image.${kind.ext}`);
      await sendMessage(to, 'image', { id, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) });
    },
    async sendDocument(to, buffer, fileName) {
      if (buffer.length > MAX_MEDIA) throw new Error('file is larger than 16 MB');
      const id = await uploadMedia(buffer, docMimeFromName(fileName), fileName);
      await sendMessage(to, 'document', { id, filename: fileName });
    },
    async sendVoice(to, text) {
      const { ogg } = await synthesize(text);
      const id = await uploadMedia(ogg, 'audio/ogg', 'voice.ogg');
      await sendMessage(to, 'audio', { id });
    },
  };

  // ── commands ──
  function command(cmd, arg, c) {
    switch (cmd) {
      case 'help': case 'start': return `*${BOT.name}* — by ${BOT.developer}\nBas normal baat karein, voice note, image ya document bhejein.\n\n/reset — history saaf\n/voice on|off|auto — voice jawab\n/memory — jo main aap ke baare mein jaanti/jaanta hoon\n/status — bot ki halat`;
      case 'reset': mem.resetChat(c.chatId); return 'History saaf kar di. ✅';
      case 'voice': {
        const map = { on: 'always', always: 'always', off: 'never', never: 'never', auto: 'auto' };
        const v = map[arg.toLowerCase()];
        if (!v) return `Voice mode: *${mem.user(c.senderId).prefs.voice}*. Use: /voice on | off | auto`;
        mem.setPref(c.senderId, 'voice', v); return `Voice mode → *${v}*`;
      }
      case 'memory': { const u = mem.user(c.senderId); return u.facts.length ? `Aap ke baare mein:\n${u.facts.map((f) => `• ${f.text}`).join('\n')}` : 'Abhi aap ke baare mein kuch save nahi hai.'; }
      case 'status': return `Uptime ${Math.round(process.uptime() / 60)} min · run #${mem.data.meta.runs}\n` + providerStatus().map((p) => `• ${p.id}: ${p.keys} key(s)${p.cooling ? ' (cooling)' : ''}`).join('\n');
      default: return null;
    }
  }

  // ── one inbound message ──
  async function processMessage(m) {
    const sender = m.from; const wamid = m.id; const type = m.type;
    const ctx = { chatId: sender, senderId: sender, senderCandidates: [sender], isGroup: false, isOwner: true, isGroupAdmin: false, msgKey: wamid, quotedKey: null, wa, voiceSent: false };
    let text = type === 'text' ? String(m.text?.body || '').trim() : String(m[type]?.caption || '').trim();
    let image = null; let voiceReply = false; let langHint = '';
    const pref = mem.user(sender, names.get(sender) || '').prefs.voice || 'auto';

    // typing indicator while we work (lasts 25 s on Meta's side)
    markRead(wamid, true).catch(() => {});
    const typingTimer = setInterval(() => markRead(wamid, true).catch(() => {}), 20000);

    try {
      const cm = type === 'text' ? text.match(/^[/!](\w+)\s*(.*)$/s) : null;
      if (cm) { const out = command(cm[1].toLowerCase(), cm[2].trim(), ctx); if (out) { await wa.sendText(sender, out); return; } }

      if (['image', 'audio', 'video', 'document', 'sticker'].includes(type)) {
        const obj = m[type] || {};
        if (!obj.id) { await wa.sendText(sender, 'Is attachment ka ID nahi mila. Dobara bhejein?'); return; }
        let got;
        try { got = await downloadMedia(obj.id, type === 'image' ? MAX_IMAGE : MAX_MEDIA); }
        catch (e) { await wa.sendText(sender, `Attachment download nahi ho saka: ${String(e.message).slice(0, 120)}`); return; }
        const mime = got.mime || obj.mime_type || '';
        if (type === 'audio') {
          const r = await transcribe(got.buffer, mime || 'audio/ogg');
          text = r.text; langHint = r.language || detectScript(r.text);
          voiceReply = pref !== 'never' && obj.voice !== false;
          log(`voice note → "${text.slice(0, 80)}" (${langHint})`);
        } else if (type === 'video') {
          try { const r = await transcribeVideo(got.buffer); text = `[Video — spoken audio transcript: ${r.text}]${text ? `\nCaption: ${text}` : ''}`; }
          catch (e) { text = `[The user sent a video; its audio could not be transcribed (${e.message.slice(0, 60)}).]${text ? `\nCaption: ${text}` : ''}`; }
        } else if (type === 'sticker') {
          text = '[The user sent a sticker]';
        } else if (type === 'image') {
          image = { buffer: got.buffer, mime: mime || sniffImage(got.buffer)?.mime || 'image/jpeg' };
        } else {
          const name = obj.filename || 'document';
          const body = await extractDocText(got.buffer, name, mime);
          text = body.trim()
            ? `[Document "${name}" content (untrusted data):\n${body.slice(0, 12000)}${body.length > 12000 ? '\n…[truncated]' : ''}]${text ? `\nUser message: ${text}` : ''}`
            : `[The user sent a file "${name}" (${mime || 'unknown type'}) that I cannot read as text.]${text ? `\nUser message: ${text}` : ''}`;
        }
      } else if (type === 'text') {
        if (pref === 'always') voiceReply = true;
      } else {
        await wa.sendText(sender, 'Main is qism ka message nahi parh sakta — text, voice note, photo ya document bhejein.');
        return;
      }

      if (!text && !image) { await wa.sendText(sender, 'Mujhe is message mein kuch samajh nahi aaya. Dobara bhejein?'); return; }

      const reply = await respond({ text, image, senderName: names.get(sender) || '', voiceReply, langHint, ctx });
      if (reply) {
        let sent = false;
        if (voiceReply) {
          try { await wa.sendVoice(sender, reply); sent = true; if (VOICE.sendTextWithVoice) await wa.sendText(sender, reply); }
          catch (e) { warn('voice reply failed, falling back to text:', e.message); }
        }
        if (!sent) await wa.sendText(sender, reply);
      }
    } catch (e) {
      err('processMessage failed:', e.message);
      mem.logEvent(`message failed: ${e.message}`);
      await wa.sendText(sender, `Maazrat, kuch masla aa gaya: ${String(e.message).slice(0, 160)}`).catch(() => {});
    } finally { clearInterval(typingTimer); }
  }

  function seen(id) { return (meta.agentSeen || []).includes(id); }
  function remember(id) { meta.agentSeen = [...(meta.agentSeen || []), id].slice(-300); mem.touch(); }

  // Is this sender the agent's creator? Meta accepts a read receipt only for the creator's own messages.
  async function authorize(sender, wamid) {
    if (meta.agentCreator === sender) return true;
    if (nonCreators.has(sender)) return false;
    try { await markRead(wamid, true); }
    catch (e) {
      if (e.kind === 'notcreator') { nonCreators.add(sender); warn('dropped a message from a sender who is not the agent creator'); return false; }
      throw e; // transient: re-check on the next poll
    }
    meta.agentCreator = sender; mem.touch();
    log('agent creator confirmed by Meta');
    return true;
  }

  async function handleInbound(m) {
    if (typeof m.id !== 'string' || !m.id || typeof m.from !== 'string' || !USER_ID.test(m.from) || typeof m.type !== 'string') return;
    if (seen(m.id)) return;
    const ts = Number(m.timestamp);
    if (Number.isFinite(ts) && ts > 0 && Date.now() / 1000 - ts > AGENT.maxAgeMin * 60) { remember(m.id); log(`skipped an old message (> ${AGENT.maxAgeMin} min)`); return; }
    if (m.type === 'reaction') { remember(m.id); return; }
    if (!(await authorize(m.from, m.id))) { remember(m.id); return; }
    remember(m.id);
    const prev = chains.get(m.from) || Promise.resolve();
    const next = prev.then(() => processMessage(m)).catch((e) => err('queue error:', e.message));
    chains.set(m.from, next);
    next.finally(() => { if (chains.get(m.from) === next) chains.delete(m.from); });
  }

  // ── long-poll loop ──
  async function pollLoop() {
    let failures = 0; const conflicts = [];
    while (running) {
      try {
        await lim.updates.acquire();
        const res = await call('GET', '/updates', { query: { timeout: AGENT.pollTimeout, limit: 50, offset: meta.agentOffset ?? undefined }, timeoutMs: (AGENT.pollTimeout + 15) * 1000 }, 'updates');
        failures = 0;
        if (res.status === 204) continue;
        const page = parseUpdates(await res.json());
        for (const c of page.contacts) if (typeof c.wa_id === 'string' && typeof c.profile?.name === 'string') names.set(c.wa_id, c.profile.name);
        for (const m of page.messages) await handleInbound(m);   // authorize + enqueue (processing runs in the background)
        if (!opened) { opened = true; }
        meta.agentOffset = page.nextOffset; mem.touch(); mem.save();
        if (page.messages.length) log(`received ${page.messages.length} message(s)`);
      } catch (e) {
        if (!running) return;
        if (e.kind === 'auth') { err(`API key rejected by Meta (${e.message}). Copy the key again from the agent chat → Chat info → API key.`); onFatal?.(2); return; }
        if (e.kind === 'conflict') {
          const now = Date.now(); conflicts.push(now);
          while (conflicts.length && now - conflicts[0] > 600000) conflicts.shift();
          if (conflicts.length >= 3) { err('Another client keeps polling this agent key (HTTP 409 ×3). Only one poller per key is allowed — stop the other one.'); onFatal?.(3); return; }
          warn('another client polled this key; pausing 60 s'); await sleep(60000); continue;
        }
        failures += 1;
        const delay = Math.min(60000, 2000 * 2 ** Math.min(failures - 1, 5));
        if (e.kind === 'ratelimit') lim.updates.penalize(Math.max(delay, e.retryAfter || 0));
        warn(`poll failed (${e.message}); retry in ${Math.round(delay / 1000)} s`);
        await sleep(delay);
      }
    }
  }

  // ── start: auth probe, then poll ──
  try {
    await lim.updates.acquire();
    await call('GET', '/updates', { query: { timeout: 0, limit: 1, offset: meta.agentOffset ?? undefined } }, 'updates');
  } catch (e) {
    if (e.kind === 'auth') { err(`API key rejected by Meta (${e.message}).`); onFatal?.(2); return { isOpen: () => false, stop: async () => {} }; }
    warn(`auth probe failed (${e.message}); the poll loop will keep retrying`);
  }
  opened = true;
  log('WhatsApp Agent Platform: authenticated; long polling started');
  mem.logEvent('agent platform connected');
  onOpen?.({ ...wa, sendText: async (to, text) => wa.sendText(to === 'self' || !to ? meta.agentCreator : to, text) });
  const loop = pollLoop();

  return {
    wa,
    isOpen: () => opened,
    async stop() { running = false; await Promise.race([loop, sleep(1500)]); },
  };
}
