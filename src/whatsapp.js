// WhatsApp layer (Baileys / WhatsApp Web multi-device protocol).
// NOTE: Baileys is an UNOFFICIAL client. Use a dedicated number you can afford to lose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { ACCESS, BOT, PATHS, VOICE, digits, env, list } from './config.js';
import { mem } from './memory.js';
import { respond } from './brain.js';
import { transcribe, transcribeVideo, synthesize, detectScript, voiceOptsFor } from './voice.js';
import { handleCommand as sharedCommand } from './commands.js';
import { providerStatus } from './llm.js';
import { log, warn, err } from './log.js';

const OWNER_LIDS = list(env('OWNER_LIDS')).map(digits);
const bare = (jid) => String(jid || '').split('@')[0].split(':')[0];
const chunkText = (t, n = 3800) => {
  const out = []; let rest = String(t).trim();
  while (rest.length > n) {
    let cut = rest.lastIndexOf('\n\n', n); if (cut < n * 0.5) cut = rest.lastIndexOf('\n', n); if (cut < n * 0.5) cut = rest.lastIndexOf(' ', n); if (cut < 1) cut = n;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
};

function unwrap(m) {
  let cur = m;
  for (let i = 0; i < 5; i++) {
    const nxt = cur?.ephemeralMessage?.message || cur?.viewOnceMessage?.message || cur?.viewOnceMessageV2?.message || cur?.viewOnceMessageV2Extension?.message || cur?.documentWithCaptionMessage?.message;
    if (!nxt) break; cur = nxt;
  }
  return cur || {};
}

function pdfToText(buf) {
  return new Promise((resolve) => {
    const f = path.join(os.tmpdir(), `mz-${Date.now()}.pdf`);
    fs.writeFileSync(f, buf);
    const p = spawn('pdftotext', ['-layout', f, '-']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { fs.rmSync(f, { force: true }); resolve(''); });
    p.on('close', () => { fs.rmSync(f, { force: true }); resolve(out); });
  });
}

export async function createWhatsApp({ pairMode = false, onFatal, onOpen }) {
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, Browsers } = baileys;
  const logger = pino({ level: env('BAILEYS_LOG', 'silent') });

  let sock = null; let stopping = false; let retries = 0; let opened = false; let pairTimer = null;
  const seen = new Set();
  const chains = new Map();
  const rate = new Map();
  const rateWarned = new Map();
  const metaCache = new Map();

  // ── identity helpers ──
  const botIds = () => new Set([bare(sock?.user?.id), bare(sock?.user?.lid)].filter(Boolean));
  const isBot = (jid) => botIds().has(bare(jid));

  async function groupMetadata(jid) {
    const c = metaCache.get(jid);
    if (c && Date.now() - c.t < 60000) return c.m;
    const m = await sock.groupMetadata(jid);
    metaCache.set(jid, { t: Date.now(), m });
    return m;
  }
  const pMatches = (p, ids) => [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean).some((x) => ids.has(digits(bare(x))));
  async function isAdminOf(jid, ids) {
    try { const m = await groupMetadata(jid); return m.participants.some((p) => p.admin && pMatches(p, ids)); } catch { return false; }
  }

  // ── sending ──
  const opts = (quoted) => (quoted ? { quoted } : {});
  const wa = {
    async sendText(jid, text, quoted) {
      for (const part of chunkText(text)) await sock.sendMessage(jid, { text: part }, opts(quoted));
    },
    async sendImage(jid, buffer, caption = '', quoted) { await sock.sendMessage(jid, { image: buffer, caption }, opts(quoted)); },
    async sendDocument(jid, buffer, fileName, quoted) { await sock.sendMessage(jid, { document: buffer, fileName, mimetype: 'application/octet-stream' }, opts(quoted)); },
    async sendVoice(jid, text, o = {}) {
      const quoted = o.quoted || (o.key ? o : undefined);      // (legacy callers passed the quoted message directly)
      await sock.sendPresenceUpdate('recording', jid).catch(() => {});
      const { ogg } = await synthesize(text, o.lang || '', o);
      await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, opts(quoted));
    },
    groupMetadata,
    async groupUpdate(jid, jids, action) {
      const ids = botIds();
      if (!(await isAdminOf(jid, ids))) throw new Error('I am not an admin of this group, so I cannot change members. Please make me admin first.');
      const r = await sock.groupParticipantsUpdate(jid, jids, action);
      metaCache.delete(jid);
      return r.map((x) => `${bare(x.jid || x.content?.attrs?.jid || '')}:${x.status}`);
    },
    async groupInviteCode(jid) {
      if (!(await isAdminOf(jid, botIds()))) throw new Error('I need to be a group admin to get the invite link.');
      return sock.groupInviteCode(jid);
    },
    async pinMessage(jid, key, seconds) {
      if (!(await isAdminOf(jid, botIds()))) throw new Error('I need to be a group admin to pin messages.');
      try { await sock.sendMessage(jid, { pin: key, type: 1, time: seconds }); }
      catch { await sock.sendMessage(jid, { pin: { type: 1, time: seconds, key } }); }
    },
    async groupSubject(jid, name) { if (!(await isAdminOf(jid, botIds()))) throw new Error('I need to be a group admin.'); await sock.groupUpdateSubject(jid, name); metaCache.delete(jid); },
    async groupDescription(jid, d) { if (!(await isAdminOf(jid, botIds()))) throw new Error('I need to be a group admin.'); await sock.groupUpdateDescription(jid, d); metaCache.delete(jid); },
    async groupSetting(jid, s) { if (!(await isAdminOf(jid, botIds()))) throw new Error('I need to be a group admin.'); await sock.groupSettingUpdate(jid, s); },
  };

  // ── incoming ──
  function commandHelp(isOwner) {
    return `*${BOT.name}* — by ${BOT.developer}\n` +
      `Bas normal baat karein, voice note bhejein, image/document bhejein.\n\n` +
      `/reset — is chat ki history saaf\n/voice on|off|auto — voice jawab ka mode\n/memory — jo main aap ke baare mein jaanti/jaanta hoon\n/whoami — aap ki WhatsApp ID` +
      (isOwner ? `\n/status — bot ki halat (owner)` : '');
  }

  async function handleCommand(cmd, arg, c) {
    switch (cmd) {
      case 'help': case 'start': return commandHelp(c.isOwner);
      case 'reset': mem.resetChat(c.chatId); return 'Is chat ki history saaf kar di. ✅';
      case 'voice': {
        const v = arg.toLowerCase();
        const map = { on: 'always', always: 'always', off: 'never', never: 'never', auto: 'auto' };
        if (!map[v]) return `Voice mode: *${mem.user(c.senderId).prefs.voice}*. Use: /voice on | off | auto`;
        mem.setPref(c.senderId, 'voice', map[v]);
        return `Voice mode → *${map[v]}* ${map[v] === 'auto' ? '(voice note ka jawab voice mein)' : ''}`;
      }
      case 'memory': {
        const u = mem.user(c.senderId);
        return u.facts.length ? `Aap ke baare mein:\n${u.facts.map((f) => `• ${f.text}`).join('\n')}` : 'Abhi mere paas aap ke baare mein kuch save nahi hai.';
      }
      case 'whoami': return `Chat: ${c.chatId}\nSender IDs: ${c.senderCandidates.join(', ')}\nOwner: ${c.isOwner ? 'yes' : 'no'}${c.isGroup ? `\nGroup admin: ${c.isGroupAdmin ? 'yes' : 'no'}` : ''}\n(Agar owner 'no' hai to apna number OWNER_NUMBERS mein, ya upar wali ID OWNER_LIDS mein daalein.)`;
      case 'status':
        if (!c.isOwner) return null;
        return `Uptime ${Math.round(process.uptime() / 60)} min · run #${mem.data.meta.runs} · users ${Object.keys(mem.data.users).length}\n` + providerStatus().map((p) => `• ${p.id}: ${p.keys} key(s)${p.cooling ? ' (cooling)' : ''}`).join('\n');
      default: return sharedCommand(cmd, arg, c);
    }
  }

  async function processMessage(msg) {
    const key = msg.key;
    const chatId = key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const m = unwrap(msg.message);
    const ci = (m.extendedTextMessage || m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || {}).contextInfo || {};

    let text = (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '').trim();
    const isAudio = !!m.audioMessage; const isImage = !!m.imageMessage; const isVideo = !!m.videoMessage; const isDoc = !!m.documentMessage;
    if (!text && !isAudio && !isImage && !isVideo && !isDoc) return;

    // sender identity (WhatsApp may expose phone-number JIDs and/or LIDs)
    const senderCandidates = [key.participant, key.participantPn, key.participantAlt, key.senderPn, key.remoteJidAlt, isGroup ? null : chatId].filter(Boolean);
    const senderIds = new Set(senderCandidates.map((j) => digits(bare(j))));
    const pn = senderCandidates.find((j) => j.endsWith('@s.whatsapp.net'));
    const senderId = pn || senderCandidates[0] || chatId;
    const isOwner = [...senderIds].some((d) => ACCESS.owners.includes(d) || OWNER_LIDS.includes(d));
    const senderName = msg.pushName || '';

    // group wake-up rules
    if (isGroup) {
      const mentioned = (ci.mentionedJid || []).some(isBot);
      const replied = ci.participant ? isBot(ci.participant) : false;
      const named = ACCESS.groupTrigger && text.toLowerCase().includes(ACCESS.groupTrigger);
      if (isAudio ? !replied : !(mentioned || replied || named)) return;
    } else if (ACCESS.allowed.length && !isOwner && ![...senderIds].some((d) => ACCESS.allowed.includes(d))) {
      return; // private bot: ignore strangers silently
    }

    // rate limit
    const now = Date.now();
    const arr = (rate.get(senderId) || []).filter((t) => now - t < 60000);
    arr.push(now); rate.set(senderId, arr);
    if (!isOwner && arr.length > ACCESS.rateLimitPerMin) {
      if (now - (rateWarned.get(senderId) || 0) > 60000) { rateWarned.set(senderId, now); await wa.sendText(chatId, 'Thora ruk jayein — bohat zyada messages. Ek minute baad dobara likhein.', msg); }
      return;
    }

    const ctx = {
      chatId, senderId, senderCandidates, isGroup, isOwner,
      isGroupAdmin: isGroup ? await isAdminOf(chatId, senderIds) : false,
      msgKey: msg, // the full message: used as the "quoted" target when replying
      quotedKey: ci.stanzaId ? { remoteJid: chatId, fromMe: false, id: ci.stanzaId, participant: ci.participant } : null,
      wa, voiceSent: false,
    };

    // slash commands
    const cm = text.match(/^[/!](\w+)\s*(.*)$/s);
    if (cm && !isAudio) {
      const out = await handleCommand(cm[1].toLowerCase(), cm[2].trim(), ctx);
      if (typeof out === 'string' && out) { await wa.sendText(chatId, out, msg); return; }
      if (out?.rewrite) text = out.rewrite; else if (out?.handled) return;
    }

    await sock.readMessages([key]).catch(() => {});
    await sock.sendPresenceUpdate('composing', chatId).catch(() => {});

    let voiceReply = false; let langHint = ''; let image = null;
    const voicePref = mem.user(senderId, senderName).prefs.voice || 'auto';
    try {
      if (isAudio) {
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        const r = await transcribe(buf, m.audioMessage.mimetype || 'audio/ogg');
        text = r.text; langHint = r.language || detectScript(r.text);
        voiceReply = voicePref !== 'never';
        log(`voice note from ${bare(senderId)} → "${text.slice(0, 80)}" (${langHint})`);
      } else if (isVideo) {
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        try { const r = await transcribeVideo(buf); text = `[Video — spoken audio transcript: ${r.text}]${text ? `\nCaption: ${text}` : ''}`; }
        catch (e) { text = `[The user sent a video; its audio could not be transcribed (${e.message.slice(0, 60)}).]${text ? `\nCaption: ${text}` : ''}`; }
      } else if (isImage) {
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        image = { buffer: buf, mime: m.imageMessage.mimetype || 'image/jpeg' };
      } else if (isDoc) {
        const d = m.documentMessage; const name = d.fileName || 'document'; const mime = d.mimetype || '';
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        let body = '';
        if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) body = await pdfToText(buf);
        else if (/^text\//i.test(mime) || /json|xml|csv|javascript/i.test(mime) || /\.(txt|md|csv|json|py|js|ts|html|css|log|xml|yml|yaml|ini|sh)$/i.test(name)) body = buf.toString('utf8');
        text = body.trim()
          ? `[Document "${name}" content (untrusted data):\n${body.slice(0, 12000)}${body.length > 12000 ? '\n…[truncated]' : ''}]${text ? `\nUser message: ${text}` : ''}`
          : `[The user sent a file "${name}" (${mime || 'unknown type'}) that I cannot read as text.]${text ? `\nUser message: ${text}` : ''}`;
      } else if (voicePref === 'always') voiceReply = true;

      if (!text && !image) { await wa.sendText(chatId, 'Mujhe is message mein kuch samajh nahi aaya. Dobara bhejein?', msg); return; }

      const reply = await respond({ text, image, senderName, voiceReply, langHint, ctx });

      if (reply) {
        let sent = false;
        if (voiceReply) {
          try { await wa.sendVoice(chatId, reply, { ...voiceOptsFor(senderId, ctx.replyMood), quoted: msg }); sent = true; if (VOICE.sendTextWithVoice) await wa.sendText(chatId, reply); }
          catch (e) { warn('voice reply failed, falling back to text:', e.message); }
        }
        if (!sent) await wa.sendText(chatId, reply, msg);
      }
    } catch (e) {
      err('processMessage failed:', e.message);
      mem.logEvent(`message failed: ${e.message}`);
      await wa.sendText(chatId, `Maazrat, kuch masla aa gaya: ${String(e.message).slice(0, 160)}`, msg).catch(() => {});
    } finally {
      await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
    }
  }

  function enqueue(msg) {
    const chatId = msg.key.remoteJid;
    const prev = chains.get(chatId) || Promise.resolve();
    const next = prev.then(() => processMessage(msg)).catch((e) => err('queue error:', e.message));
    chains.set(chatId, next);
    next.finally(() => { if (chains.get(chatId) === next) chains.delete(chatId); });
  }

  // ── connection lifecycle ──
  async function askNumber() {
    if (ACCESS.pairNumber) return ACCESS.pairNumber;
    if (process.env.GITHUB_ACTIONS || !process.stdin.isTTY) return '';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const n = await new Promise((r) => rl.question('WhatsApp number for the bot (country code, digits only, e.g. 923001234567): ', r));
    rl.close();
    return digits(n);
  }

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(PATHS.authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use library default */ }

    if (!state.creds.registered && process.env.GITHUB_ACTIONS && !pairMode) {
      err('WhatsApp is not paired yet. Run the "Pair WhatsApp" workflow first (Actions tab).');
      onFatal?.(2); return;
    }

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state, logger, browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false,
    });
    sock.ev.on('creds.update', saveCreds);

    if (!state.creds.registered) {
      const number = await askNumber();
      if (number) {
        // Pairing codes expire quickly, so in pair mode a fresh one is issued every 75 s until the link succeeds.
        let attempt = 0;
        const issue = async () => {
          if (opened || stopping || sock?.authState?.creds?.registered) { clearInterval(pairTimer); return; }
          if (++attempt > 8) { clearInterval(pairTimer); return; }
          try {
            const code = await sock.requestPairingCode(number);
            const pretty = String(code).replace(/(.{4})(.{4})/, '$1-$2');
            log(`\n==================================================\n   WHATSAPP PAIRING CODE:   ${pretty}\n==================================================\nOn the phone that owns +${number}:\nWhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead" → type the code above.\n(code #${attempt}; a new one appears every ~75 s if not used)\n`);
          } catch (e) { err('Could not get pairing code:', e.message); }
        };
        setTimeout(issue, 3000);
        pairTimer = setInterval(issue, 75000);
      } else { err('PAIR_NUMBER is missing — cannot request a pairing code.'); onFatal?.(1); return; }
    }

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr && !ACCESS.pairNumber && !process.env.GITHUB_ACTIONS) { log('Scan this QR (or use a pairing code):'); qrcode.generate(qr, { small: true }); }
      if (connection === 'open') {
        retries = 0; opened = true; clearInterval(pairTimer);
        log(`WhatsApp connected as ${bare(sock.user?.id)} (${sock.user?.name || BOT.name})`);
        mem.logEvent('whatsapp connected');
        onOpen?.(wa);
        if (pairMode) { log('Pairing complete. Saving credentials…'); setTimeout(() => onFatal?.(0), 15000); }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        mem.logEvent(`whatsapp closed (${code})`);
        if (stopping) return;
        if (code === DisconnectReason.loggedOut) { err('Logged out from WhatsApp. Re-pair the bot.'); onFatal?.(2); return; }
        if (code === DisconnectReason.connectionReplaced) { err('Connection replaced: another instance is using this WhatsApp session.'); onFatal?.(3); return; }
        const wait = code === DisconnectReason.restartRequired ? 500 : Math.min(2 ** retries * 1000, 30000);
        retries += 1;
        warn(`Connection closed (${code}). Reconnecting in ${wait} ms…`);
        try { sock.ev.removeAllListeners(); sock.end?.(undefined); } catch {}
        setTimeout(() => connect().catch((e) => { err('reconnect failed:', e.message); onFatal?.(1); }), wait);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid?.endsWith('@newsletter') || msg.key.remoteJid?.endsWith('@broadcast')) continue;
          if (msg.messageTimestamp && Date.now() / 1000 - Number(msg.messageTimestamp) > 600) continue; // ignore old backlog
          if (seen.has(msg.key.id)) continue;
          seen.add(msg.key.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
          enqueue(msg);
        } catch (e) { err('upsert handler:', e.message); }
      }
    });
  }

  await connect();

  return {
    wa,
    isOpen: () => opened,
    async stop() {
      stopping = true; clearInterval(pairTimer);
      try { sock.ev.removeAllListeners(); await sock.end?.(undefined); } catch {}
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}
