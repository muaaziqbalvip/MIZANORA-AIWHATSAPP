// Tool registry. Each tool: { desc, params, access, run(args, ctx) }.
// access: 'all' | 'owner' | 'group-admin' (owner OR admin of the current group, group chats only)
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, digits } from '../config.js';
import { mem } from '../memory.js';
import { fetchUrl, getWeather } from './net.js';
import { webSearch, newsSearch, wikipedia, deepResearch } from './search.js';
import { convertCurrency, cryptoPrice } from './finance.js';
import { browseTool, screenshotTool, browserTaskTool, closeBrowser, browserAvailable } from './browser.js';
import { firstDue, normalizeRepeat, describeRepeat } from '../scheduler.js';
import { voiceOptsFor } from '../voice.js';
import { execFile } from 'node:child_process';
import { generateImageBuffer } from './image.js';
import { runPython, runShell, listWorkspace } from './exec.js';
import { providerStatus } from '../llm.js';
import { composeMusic, generateSong } from './music.js';

const str = (d, extra = {}) => ({ type: 'string', description: d, ...extra });
const num = (d) => ({ type: 'number', description: d });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

const toJid = (n) => {
  const d = digits(n);
  if (d.length < 8 || d.length > 15) throw new Error(`"${n}" is not a valid international number (use country code, e.g. 923001234567)`);
  return `${d}@s.whatsapp.net`;
};
const numbersArg = (a) => (Array.isArray(a) ? a : String(a || '').split(/[\s,;]+/)).filter(Boolean).slice(0, 20);

const TOOLS = {
  // ───────── everyone ─────────
  web_search: {
    access: 'all',
    desc: 'Search the live web (Google-grounded + Bing + DuckDuckGo + optional Tavily/Brave/Serper, merged and ranked). Use for anything current or uncertain: news, prices, scores, "latest", facts that may have changed. For a big or contested question use deep_research instead.',
    params: obj({ query: str('Concise search query (2-8 words work best)'), max_results: num('1-8, default 5'), recency: str('Only results from the last: day | week | month | year (omit for any time)', { enum: ['day', 'week', 'month', 'year'] }) }, ['query']),
    run: (a) => webSearch(a),
  },
  news_search: {
    access: 'all',
    desc: 'Latest news headlines with publisher and age (Google News + Bing News), newest first. Use for "news", "what happened", "breaking", current events.',
    params: obj({ query: str('Topic, person, place or event'), max_results: num('1-10, default 6'), recency: str('day | week | month (default week)', { enum: ['day', 'week', 'month'] }) }, ['query']),
    run: (a) => newsSearch(a),
  },
  deep_research: {
    access: 'all',
    desc: 'In-depth research: plans several searches, reads the best pages, cross-checks sources and returns a cited brief. Takes 20-60 s. Use for comparisons, "explain/why/how", buying decisions, anything needing more than one source.',
    params: obj({ question: str('The full research question'), depth: str('quick | normal | deep (default normal)', { enum: ['quick', 'normal', 'deep'] }), recency: str('day | week | month | year — restrict to fresh sources', { enum: ['day', 'week', 'month', 'year'] }) }, ['question']),
    run: (a, ctx) => deepResearch(a, { progress: ctx.progress }),
  },
  wikipedia: {
    access: 'all',
    desc: 'Wikipedia summary of a person/place/concept. lang: en, ur, hi, ar…',
    params: obj({ query: str('Topic'), lang: str('Wikipedia language code, default en') }, ['query']),
    run: (a) => wikipedia(a),
  },
  currency_convert: {
    access: 'all', desc: 'Convert money between currencies at the current rate (e.g. USD → PKR).',
    params: obj({ amount: num('Amount, default 1'), from: str('3-letter code, e.g. USD'), to: str('3-letter code, e.g. PKR') }, ['from', 'to']),
    run: (a) => convertCurrency(a),
  },
  crypto_price: {
    access: 'all', desc: 'Live cryptocurrency price and 24h change (btc, eth, sol, doge… or any CoinGecko name).',
    params: obj({ coin: str('Symbol or name, e.g. btc'), vs: str('Comma list of currencies, default usd,pkr') }, ['coin']),
    run: (a) => cryptoPrice(a),
  },
  fetch_url: {
    access: 'all',
    desc: 'Download and read a public web page (article, docs) and return its text. Use after web_search to read a result in full.',
    params: obj({ url: str('Full http(s) URL'), max_chars: num('Max characters to return (default 6000)') }, ['url']),
    run: (a) => fetchUrl(a),
  },
  get_weather: {
    access: 'all',
    desc: 'Current weather and 3-day forecast for a city.',
    params: obj({ city: str('City name, e.g. "Lahore"') }, ['city']),
    run: (a) => getWeather(a),
  },
  generate_image: {
    access: 'all',
    desc: 'Generate an image from a text prompt and send it to the chat. Write the prompt in English, detailed (subject, style, lighting, composition).',
    params: obj({ prompt: str('Detailed English image prompt'), caption: str('Optional caption to send with the image') }, ['prompt']),
    run: async (a, ctx) => {
      const buf = await generateImageBuffer(String(a.prompt).slice(0, 900));
      await ctx.wa.sendImage(ctx.chatId, buf, a.caption || '', ctx.msgKey);
      return 'Image generated and delivered to the chat. Do not describe it in detail; just add a short remark.';
    },
  },
  send_voice_note: {
    access: 'all',
    desc: 'Send text as a WhatsApp voice note (use when the user asks you to speak / reply in voice). Write the text in the user\'s language and native script (Urdu in Urdu script). Pick a mood so the voice sounds natural.',
    params: obj({ text: str('Exactly what to say aloud'), mood: str('neutral | happy | excited | calm | serious | sad | caring | apology', { enum: ['neutral', 'happy', 'excited', 'calm', 'serious', 'sad', 'caring', 'apology'] }) }, ['text']),
    run: async (a, ctx) => { await ctx.wa.sendVoice(ctx.chatId, a.text, { ...voiceOptsFor(ctx.senderId, a.mood || ''), quoted: ctx.msgKey }); ctx.voiceSent = true; return 'Voice note sent.'; },
  },
  set_voice_style: {
    access: 'all',
    desc: 'Change how the user\'s voice replies sound: gender (male|female) and speed (0.8 slow … 1.3 fast). Also use when the user says "awaaz slow karo", "mard ki awaaz", etc.',
    params: obj({ gender: str('male | female', { enum: ['male', 'female'] }), speed: num('0.7-1.5, default 1') }),
    run: (a, ctx) => {
      if (a.gender) mem.setPref(ctx.senderId, 'voiceGender', a.gender === 'male' ? 'male' : 'female');
      if (a.speed) mem.setPref(ctx.senderId, 'voiceSpeed', Math.min(Math.max(Number(a.speed) || 1, 0.7), 1.5));
      const p = mem.user(ctx.senderId).prefs; return `Voice style saved: ${p.voiceGender || 'female'}, speed ${p.voiceSpeed || 1}.`;
    },
  },
  remember_fact: {
    access: 'all',
    desc: 'Save a durable fact or preference about the user (name, profession, language, preferences, ongoing projects) so you remember it in future chats. Do not store passwords, card numbers or government IDs.',
    params: obj({ fact: str('One short factual sentence') }, ['fact']),
    run: (a, ctx) => (mem.addFact(ctx.senderId, a.fact) ? 'Saved.' : 'Already known.'),
  },
  forget_fact: {
    access: 'all',
    desc: 'Delete stored facts about the user that contain a keyword.',
    params: obj({ keyword: str('Keyword to match') }, ['keyword']),
    run: (a, ctx) => `Removed ${mem.forgetFact(ctx.senderId, a.keyword)} fact(s).`,
  },
  set_reminder: {
    access: 'all',
    desc: 'Schedule a reminder message in this chat. Give in_minutes OR at (ISO 8601 with timezone offset, e.g. 2026-10-01T09:00:00+05:00). For a repeating reminder add repeat. Set voice=true to have it spoken.',
    params: obj({ text: str('What to remind about'), in_minutes: num('Minutes from now'), at: str('Absolute ISO time'), repeat: { type: 'object', description: 'Optional recurrence: {type:"daily",time:"08:00"} | {type:"weekly",days:[1..7 Mon=1],time:"21:30"} | {type:"every",minutes:90}. Times are in the bot timezone.' }, voice: { type: 'boolean', description: 'Deliver as a voice note' } }, ['text']),
    run: (a, ctx) => {
      const repeat = normalizeRepeat(a.repeat);
      const due = firstDue({ in_minutes: a.in_minutes, at: a.at, repeat });
      const t = mem.addTask({ chatId: ctx.chatId, dueAt: due, text: a.text, createdBy: ctx.senderId, repeat, voice: a.voice });
      return `Reminder ${t.id} set for ${new Date(due).toISOString()} (${describeRepeat(repeat)}).`;
    },
  },
  schedule_task: {
    access: 'owner',
    desc: 'Automation: schedule a PROMPT that you run yourself (with web search, browser, weather… tools) at a time or on a repeat, and send the result to this chat — e.g. "every day 8am: weather + top news", "every Friday: check dollar rate", "tomorrow 9am: research X". Write the prompt as a complete self-contained instruction.',
    params: obj({ prompt: str('Self-contained instruction to execute when it fires'), in_minutes: num('Minutes from now (one-off)'), at: str('Absolute ISO time (one-off)'), repeat: { type: 'object', description: '{type:"daily",time:"08:00"} | {type:"weekly",days:[1..7],time:"21:30"} | {type:"every",minutes:120}' }, voice: { type: 'boolean', description: 'Send the result as a voice note' } }, ['prompt']),
    run: (a, ctx) => {
      const repeat = normalizeRepeat(a.repeat);
      const due = firstDue({ in_minutes: a.in_minutes, at: a.at, repeat });
      const t = mem.addTask({ chatId: ctx.chatId, dueAt: due, text: a.prompt, createdBy: ctx.senderId, kind: 'agent', repeat, voice: a.voice });
      return `Scheduled task ${t.id}: first run ${new Date(due).toISOString()} (${describeRepeat(repeat)}${a.voice ? ', voice' : ''}). Cancel with cancel_reminder id ${t.id}.`;
    },
  },
  list_reminders: {
    access: 'all', desc: 'List pending reminders and scheduled tasks in this chat.', params: obj({}),
    run: (_a, ctx) => mem.pendingTasks(ctx.chatId).map((t) => `${t.id}: ${t.kind === 'agent' ? '🤖 task' : '⏰'} ${new Date(t.dueAt).toISOString()} (${describeRepeat(t.repeat)}) — ${t.text.slice(0, 120)}`).join('\n') || 'No pending reminders or tasks.',
  },
  cancel_reminder: {
    access: 'all', desc: 'Cancel a reminder by id.', params: obj({ id: str('Reminder id') }, ['id']),
    run: (a) => (mem.cancelTask(a.id) ? 'Cancelled.' : 'No such pending reminder.'),
  },

  // ───────── owner only ─────────
  run_python: {
    access: 'owner',
    desc: 'Execute Python 3 code on the host and return stdout/stderr. For calculations, data processing, scraping, file generation (files persist in the workspace).',
    params: obj({ code: str('Complete Python script'), timeout_sec: num('Default 60, max 170') }, ['code']),
    run: (a) => runPython(a),
  },
  run_shell: {
    access: 'owner',
    desc: 'Run a bash command on the host machine (workspace is the working directory).',
    params: obj({ command: str('Bash command'), timeout_sec: num('Default 60, max 170') }, ['command']),
    run: (a) => runShell(a),
  },
  browse: {
    access: 'owner',
    desc: 'Open a page in the real headless browser (handles JavaScript sites, dynamic content) and return its title, numbered interactive elements and visible text. Set screenshot=true to also send a screenshot to the chat. For multi-step goals use browser_task.',
    params: obj({ url: str('URL or a bare site name like "youtube"'), screenshot: { type: 'boolean', description: 'Also send a screenshot' }, max_chars: num('Text chars to return (500-3200)') }, ['url']),
    run: (a, ctx) => browseTool(a, ctx),
  },
  screenshot: {
    access: 'owner',
    desc: 'Take a screenshot of a web page (or of the page currently open) and send it to the chat as an image.',
    params: obj({ url: str('URL to open first (omit to shoot the current page)'), full_page: { type: 'boolean', description: 'Capture the whole scrolling page' }, caption: str('Optional caption') }),
    run: (a, ctx) => screenshotTool(a, ctx),
  },
  browser_task: {
    access: 'owner',
    desc: 'Autonomous web agent: give a GOAL and it browses on its own (search, open pages, click, fill forms, scroll, read) until done — e.g. "find the cheapest 128GB phone on daraz.pk", "check flight prices Lahore→Dubai next Friday", "open this page and summarise the pricing table". Takes 30-120 s. It never enters passwords/cards and asks before buying/posting/deleting.',
    params: obj({ goal: str('What to achieve, with all details'), start_url: str('Optional URL to start from'), max_steps: num('Default 14, max 30'), allow_sensitive: { type: 'boolean', description: 'ONLY true after the user explicitly confirmed a buy/post/send/delete step' }, screenshot_at_end: { type: 'boolean', description: 'Send a final screenshot (default true)' } }, ['goal']),
    run: (a, ctx) => browserTaskTool(a, ctx),
  },
  browser_close: { access: 'owner', desc: 'Close the browser and free memory.', params: obj({}), run: () => closeBrowser('requested') },
  generate_song: {
    access: 'owner', desc: 'Create a REAL full song with vocals (Google Lyria, studio quality, costs API credit) and send it as MP3. Describe genre/mood/language in prompt; optionally pass your own lyrics. If it fails the offline synth tool compose_music is the fallback.',
    params: obj({ prompt: str('Style, mood, language, topic, e.g. "emotional Urdu ghazal, soft piano, female vocals"'), lyrics: str('Optional lyrics with [Verse]/[Chorus] markers'), instrumental: { type: 'boolean', description: 'true = no vocals' } }, ['prompt']),
    run: async (a, ctx) => { const r = await generateSong(a); await ctx.wa.sendDocument(ctx.chatId, r.buf, `song-${Date.now()}.mp3`, ctx.msgKey); return `Song sent (${r.model}).${r.lyrics ? ` Lyrics/structure:\n${r.lyrics.slice(0, 1500)}` : ''}`; },
  },
  compose_music: {
    access: 'all', desc: 'Compose a short instrumental song and send it as an MP3. YOU write the music: tempo, up to 6 tracks, each with instrument (piano|pad|bass|lead|pluck) and notes text like "C4:1 E4:1 G4:2 R:1 C4+E4+G4:4" (note+octave:beats, R=rest, + = chord). Optional drums string of 16th steps using k(kick) s(snare) h(hat) . (rest), e.g. "k.h.s.h.k.h.s.h.". Make 8-16 bars, a clear melody, chords and bass.',
    params: obj({ title: str('Song title'), tempo: num('BPM 50-200'), bars: num('Bars if drums only'), drums: str('Drum pattern'), tracks: { type: 'array', items: obj({ instrument: str('piano|pad|bass|lead|pluck'), notes: str('Note text'), volume: num('0.1-1') }, ['instrument', 'notes']) } }, ['title', 'tracks']),
    run: async (a, ctx) => { const r = await composeMusic(a); await ctx.wa.sendDocument(ctx.chatId, fs.readFileSync(r.file), path.basename(r.file), ctx.msgKey); return `Song sent (${r.seconds}s). Synth-style instrumental, not a studio vocal track.`; },
  },
  write_file: {
    access: 'owner', desc: 'Create/overwrite a text file in the workspace (code, notes, csv, html…). Then use send_workspace_file to deliver it.',
    params: obj({ filename: str('Name inside the workspace, e.g. report.md or site/index.html'), content: str('File content') }, ['filename', 'content']),
    run: (a) => { const p = path.resolve(PATHS.workspace, a.filename); if (!p.startsWith(PATHS.workspace + path.sep)) throw new Error('Path escapes the workspace'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(a.content)); return `Wrote ${path.relative(PATHS.workspace, p)} (${Buffer.byteLength(String(a.content))} bytes).`; },
  },
  read_file: {
    access: 'owner', desc: 'Read a text file from the workspace.', params: obj({ filename: str('File name in the workspace'), max_chars: num('Default 6000') }, ['filename']),
    run: (a) => { const p = path.resolve(PATHS.workspace, a.filename); if (!p.startsWith(PATHS.workspace + path.sep) || !fs.existsSync(p)) throw new Error('File not found in workspace'); return fs.readFileSync(p, 'utf8').slice(0, Math.min(Number(a.max_chars) || 6000, 12000)); },
  },
  zip_and_send: {
    access: 'owner', desc: 'Zip a workspace folder or file and send the .zip to the chat (e.g. a generated project/website).',
    params: obj({ path: str('Folder or file inside the workspace') }, ['path']),
    run: async (a, ctx) => {
      const src = path.resolve(PATHS.workspace, a.path);
      if (!(src + path.sep).startsWith(PATHS.workspace + path.sep) || !fs.existsSync(src)) throw new Error('Path not found in workspace');
      const out = path.join(PATHS.workspace, `${path.basename(src)}-${Date.now()}.zip`);
      await new Promise((res, rej) => execFile('python3', ['-m', 'zipfile', '-c', out, src], { cwd: PATHS.workspace, timeout: 60000 }, (e) => (e ? rej(e) : res())));
      await ctx.wa.sendDocument(ctx.chatId, fs.readFileSync(out), path.basename(out), ctx.msgKey);
      return `Sent ${path.basename(out)}.`;
    },
  },
  list_workspace: { access: 'owner', desc: 'List files in the bot workspace.', params: obj({}), run: () => listWorkspace() },
  send_workspace_file: {
    access: 'owner',
    desc: 'Send a file from the workspace to the chat as a document.',
    params: obj({ filename: str('File name inside the workspace') }, ['filename']),
    run: async (a, ctx) => {
      const p = path.resolve(PATHS.workspace, a.filename);
      if (!p.startsWith(PATHS.workspace + path.sep) || !fs.existsSync(p)) throw new Error('File not found in workspace');
      await ctx.wa.sendDocument(ctx.chatId, fs.readFileSync(p), path.basename(p), ctx.msgKey);
      return 'File sent.';
    },
  },
  system_status: {
    access: 'owner',
    desc: 'Show bot health: uptime, memory size, active AI providers/keys.',
    params: obj({}),
    run: () => {
      const up = Math.round(process.uptime() / 60);
      return `Uptime ${up} min. Browser ${browserAvailable() ? 'enabled' : 'disabled'}. Users ${Object.keys(mem.data.users).length}, chats ${Object.keys(mem.data.chats).length}, pending tasks ${mem.pendingTasks().length}, run #${mem.data.meta.runs}.\nProviders:\n` +
        providerStatus().map((p) => `- ${p.id}: ${p.keys} key(s), model ${p.model}${p.cooling ? ' (cooling)' : ''}`).join('\n');
    },
  },

  // ───────── groups: owner or group admin (bot must itself be admin for changes) ─────────
  group_info: {
    access: 'group', desc: 'Get this group\'s name, description, member count and admins.', params: obj({}),
    run: async (_a, ctx) => {
      const m = await ctx.wa.groupMetadata(ctx.chatId);
      const admins = m.participants.filter((p) => p.admin).map((p) => digits(p.phoneNumber || p.jid || p.id));
      return `Name: ${m.subject}\nMembers: ${m.participants.length}\nAdmins: ${admins.join(', ')}\nDescription: ${m.desc || '(none)'}`;
    },
  },
  group_add_members: {
    access: 'group-admin', desc: 'Add people to this group by phone number (international format, digits only).',
    params: obj({ numbers: { type: 'array', items: { type: 'string' }, description: 'Phone numbers with country code' } }, ['numbers']),
    run: async (a, ctx) => JSON.stringify(await ctx.wa.groupUpdate(ctx.chatId, numbersArg(a.numbers).map(toJid), 'add')),
  },
  group_remove_members: {
    access: 'group-admin', desc: 'Remove people from this group by phone number.',
    params: obj({ numbers: { type: 'array', items: { type: 'string' }, description: 'Phone numbers with country code' } }, ['numbers']),
    run: async (a, ctx) => JSON.stringify(await ctx.wa.groupUpdate(ctx.chatId, numbersArg(a.numbers).map(toJid), 'remove')),
  },
  group_promote_admin: {
    access: 'group-admin', desc: 'Make members group admins.',
    params: obj({ numbers: { type: 'array', items: { type: 'string' }, description: 'Phone numbers with country code' } }, ['numbers']),
    run: async (a, ctx) => JSON.stringify(await ctx.wa.groupUpdate(ctx.chatId, numbersArg(a.numbers).map(toJid), 'promote')),
  },
  group_demote_admin: {
    access: 'group-admin', desc: 'Remove admin rights from members.',
    params: obj({ numbers: { type: 'array', items: { type: 'string' }, description: 'Phone numbers with country code' } }, ['numbers']),
    run: async (a, ctx) => JSON.stringify(await ctx.wa.groupUpdate(ctx.chatId, numbersArg(a.numbers).map(toJid), 'demote')),
  },
  group_invite_link: {
    access: 'group-admin', desc: 'Get the invite link of this group.', params: obj({}),
    run: async (_a, ctx) => `https://chat.whatsapp.com/${await ctx.wa.groupInviteCode(ctx.chatId)}`,
  },
  group_pin_message: {
    access: 'group-admin', desc: 'Pin the message the user is replying to (the user must reply to the message to pin).',
    params: obj({ days: num('7, 30 or 1 (default 7)') }),
    run: async (a, ctx) => {
      if (!ctx.quotedKey) throw new Error('Ask the user to reply to the message they want pinned.');
      const days = Number(a.days) === 30 ? 2592000 : Number(a.days) === 1 ? 86400 : 604800;
      await ctx.wa.pinMessage(ctx.chatId, ctx.quotedKey, days);
      return 'Message pinned.';
    },
  },
  group_set_name: {
    access: 'group-admin', desc: 'Change the group name.', params: obj({ name: str('New group name') }, ['name']),
    run: async (a, ctx) => { await ctx.wa.groupSubject(ctx.chatId, String(a.name).slice(0, 100)); return 'Group name updated.'; },
  },
  group_set_description: {
    access: 'group-admin', desc: 'Change the group description.', params: obj({ description: str('New description') }, ['description']),
    run: async (a, ctx) => { await ctx.wa.groupDescription(ctx.chatId, String(a.description).slice(0, 2000)); return 'Group description updated.'; },
  },
  group_only_admins_can_send: {
    access: 'group-admin', desc: 'Lock or unlock the group so only admins can send messages.',
    params: obj({ locked: { type: 'boolean', description: 'true = only admins can send' } }, ['locked']),
    run: async (a, ctx) => { await ctx.wa.groupSetting(ctx.chatId, a.locked ? 'announcement' : 'not_announcement'); return a.locked ? 'Only admins can send now.' : 'Everyone can send now.'; },
  },
};

if (process.env.AGENT_UID) { delete TOOLS.run_shell; delete TOOLS.run_python; } // hosted user agents share a runner with the admin secret
function allowed(tool, ctx) {
  switch (tool.access) {
    case 'all': return true;
    case 'owner': return !!ctx.isOwner;
    case 'group': return ctx.isGroup && (ctx.isOwner || ctx.isGroupAdmin);
    case 'group-admin': return ctx.isGroup && (ctx.isOwner || ctx.isGroupAdmin);
    default: return false;
  }
}

export function toolSpecs(ctx) {
  return Object.entries(TOOLS)
    .filter(([, t]) => allowed(t, ctx))
    .map(([name, t]) => ({ type: 'function', function: { name, description: t.desc, parameters: t.params } }));
}

export function toolNames(ctx) { return toolSpecs(ctx).map((t) => t.function.name); }

export async function executeTool(name, rawArgs, ctx) {
  const tool = TOOLS[name];
  if (!tool) return `Error: unknown tool "${name}".`;
  if (!allowed(tool, ctx)) return `Error: you are not permitted to use "${name}" here (${tool.access === 'owner' ? 'owner only' : 'group admins/owner only, in group chats'}).`;
  let args = rawArgs;
  if (typeof rawArgs === 'string') { try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {}; } catch { return 'Error: tool arguments were not valid JSON.'; } }
  try {
    const out = await Promise.race([
      Promise.resolve(tool.run(args || {}, ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tool timed out')), 180000)),
    ]);
    return String(out ?? 'done').slice(0, 7000);
  } catch (e) {
    mem.logEvent(`tool ${name} failed: ${e.message}`);
    return `Error: ${e.message}`;
  }
}
