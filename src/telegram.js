// Telegram transport (long polling) — same brain/tools as WhatsApp. Text, voice notes, photos, documents, inline buttons.
import { respond } from './brain.js';
import { handleCommand } from './commands.js';
import { transcribe, synthesize, voiceOptsFor, detectScript } from './voice.js';
import { extractDocText } from './docs.js';
import { mem } from './memory.js';
import { env, VOICE } from './config.js';
import { log, warn, err } from './log.js';

const TOKEN = env('TELEGRAM_BOT_TOKEN', '');
const API = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;
const call = async (m, body, ms = 40000) => { const r = await fetch(API(m), { method: 'POST', headers: body instanceof FormData ? {} : { 'content-type': 'application/json' }, body: body instanceof FormData ? body : JSON.stringify(body || {}), signal: AbortSignal.timeout(ms) }); const j = await r.json(); if (!j.ok) throw new Error(`${m}: ${j.description}`); return j.result; };
const chunk = (t, n = 4000) => { const o = []; let s = String(t); while (s.length > n) { let i = s.lastIndexOf('\n', n); if (i < n / 2) i = n; o.push(s.slice(0, i)); s = s.slice(i); } o.push(s); return o.filter((x) => x.trim()); };
const form = (o, file, name, mime) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); f.append(file.field, new Blob([file.buf], { type: mime }), name); return f; };
export const MENU = { inline_keyboard: [[{ text: '🔎 Research', callback_data: '/research ' }, { text: '📰 News', callback_data: '/news' }], [{ text: '🎙️ Voice on', callback_data: '/voice on' }, { text: '⏰ Tasks', callback_data: '/tasks' }], [{ text: '📺 News video', callback_data: '/newsvideo now' }, { text: '❓ Help', callback_data: '/help' }]] };

export async function createTelegram({ onOpen, onFatal }) {
  if (!TOKEN) { err('TELEGRAM_BOT_TOKEN is not set.'); onFatal?.(2); return { isOpen: () => false, stop: async () => {} }; }
  const me = await call('getMe').catch((e) => { err('Telegram auth failed:', e.message); onFatal?.(2); return null; });
  if (!me) return { isOpen: () => false, stop: async () => {} };
  let stopped = false, offset = mem.data.meta.tgOffset || 0;
  const wa = {
    async sendText(to, text, extra = {}) { for (const p of chunk(text)) await call('sendMessage', { chat_id: to, text: p, disable_web_page_preview: true, ...extra }); },
    async sendVoice(to, text, o = {}) { const { ogg } = await synthesize(text, o.lang || '', o); await call('sendVoice', form({ chat_id: to }, { field: 'voice', buf: ogg }, 'v.ogg', 'audio/ogg'), 90000); },
    async sendImage(to, buf, caption = '') { await call('sendPhoto', form({ chat_id: to, caption: String(caption).slice(0, 1000) }, { field: 'photo', buf }, 'i.jpg', 'image/jpeg'), 90000); },
    async sendDocument(to, buf, name = 'file') { await call('sendDocument', form({ chat_id: to }, { field: 'document', buf }, name, 'application/octet-stream'), 120000); },
    async sendVideo(to, buf, caption = '') { await call('sendVideo', form({ chat_id: to, caption: String(caption).slice(0, 1000), supports_streaming: 'true' }, { field: 'video', buf }, 'news.mp4', 'video/mp4'), 300000); },
  };
  const download = async (id) => { const f = await call('getFile', { file_id: id }); const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(60000) }); return Buffer.from(await r.arrayBuffer()); };

  async function handle(m) {
    const chatId = String(m.chat.id), uid = String(m.from.id);
    if (!mem.data.meta.tgOwner) { mem.data.meta.tgOwner = uid; mem.touch(); }          // first person to message the bot is the owner
    const allowed = env('TELEGRAM_ALLOWED_IDS', '').split(',').filter(Boolean);
    const isOwner = uid === String(mem.data.meta.tgOwner);
    if (allowed.length && !isOwner && !allowed.includes(uid)) return;
    let text = m.text || m.caption || '', image = null, voiceReply = false, langHint = '';
    let stop = false; const typing = setInterval(() => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4000);
    const ctx = { chatId, senderId: uid, senderCandidates: [uid], isGroup: m.chat.type !== 'private', isOwner, isGroupAdmin: false, msgKey: null, quotedKey: null, wa, voiceSent: false, progress: (t) => wa.sendText(chatId, t).catch(() => {}) };
    try {
      if (m.voice || m.audio) { const t = await transcribe(await download((m.voice || m.audio).file_id), 'audio/ogg'); text = t.text || t; langHint = t.language || ''; voiceReply = mem.user(uid).prefs.voice !== 'never'; if (!text) return wa.sendText(chatId, 'Awaaz samajh nahi aayi, dobara bhejein.'); }
      else if (m.photo) image = { buffer: await download(m.photo.at(-1).file_id), mime: 'image/jpeg' };
      else if (m.document) { const d = await extractDocText(await download(m.document.file_id), m.document.file_name || 'file', m.document.mime_type || ''); text = `[Document "${m.document.file_name}"]\n${d}\n${text}`; }
      else if (m.location) text = `[The user shared a location: lat ${m.location.latitude}, lon ${m.location.longitude}]`;
      else if (mem.user(uid).prefs.voice === 'always') voiceReply = true;
      const cm = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
      if (cm) { const o = await handleCommand(cm[1].toLowerCase(), cm[2].trim(), ctx); if (typeof o === 'string' && o) return wa.sendText(chatId, o, cm[1] === 'start' || cm[1] === 'help' ? { reply_markup: MENU } : {}); if (o?.rewrite) text = o.rewrite; else if (o?.handled) return; }
      if (!text && !image) return;
      const reply = await respond({ text, image, senderName: m.from.first_name || '', voiceReply, langHint, ctx });
      if (reply) { let sent = false; if (voiceReply) { try { await wa.sendVoice(chatId, reply, { ...voiceOptsFor(uid, ctx.replyMood), lang: ['ur', 'hi'].includes(langHint) ? langHint : '' }); sent = true; if (reply.length > VOICE.maxChars) await wa.sendText(chatId, reply); } catch (e) { warn('tg voice failed:', e.message.slice(0, 80)); } } if (!sent) await wa.sendText(chatId, reply); }
    } catch (e) { err('telegram message failed:', e.message); await wa.sendText(chatId, 'Maazrat, kuch masla aa gaya. Dobara koshish karein.').catch(() => {}); }
    finally { clearInterval(typing); }
  }

  (async () => { // poll loop
    let wait = 2000;
    while (!stopped) {
      try {
        const ups = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, 45000); wait = 2000;
        for (const u of ups) {
          offset = u.update_id + 1; mem.data.meta.tgOffset = offset; mem.touch();
          if (u.callback_query) { call('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {}); const q = u.callback_query; if (q.data?.endsWith(' ')) await wa.sendText(q.message.chat.id, 'Sawal likh kar bhejein: ' + q.data.trim() + ' <sawal>'); else await handle({ chat: q.message.chat, from: q.from, text: q.data }); }
          else if (u.message) handle(u.message);
        }
      } catch (e) { if (stopped) break; warn(`telegram poll failed (${e.message.slice(0, 60)}); retry in ${wait / 1000}s`); await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000); }
    }
  })();
  log(`Telegram connected as @${me.username}`);
  onOpen?.(wa);
  return { isOpen: () => true, stop: async () => { stopped = true; } };
}
