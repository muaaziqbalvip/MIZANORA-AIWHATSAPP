// Tool registry. Each tool: { desc, params, access, run(args, ctx) }.
// access: 'all' | 'owner' | 'group-admin' (owner OR admin of the current group, group chats only)
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, digits } from '../config.js';
import { mem } from '../memory.js';
import { webSearch, fetchUrl, getWeather } from './net.js';
import { generateImageBuffer } from './image.js';
import { runPython, runShell, listWorkspace } from './exec.js';
import { providerStatus } from '../llm.js';

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
    desc: 'Search the live web for current information: news, prices, weather context, sports, facts that may have changed, anything after your training data. Use it whenever freshness matters.',
    params: obj({ query: str('Concise search query'), max_results: num('1-8, default 5') }, ['query']),
    run: (a) => webSearch(a),
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
    desc: 'Send text as a WhatsApp voice note (use when the user asks you to speak / reply in voice). Write the text in the user\'s language and native script (Urdu in Urdu script).',
    params: obj({ text: str('Exactly what to say aloud') }, ['text']),
    run: async (a, ctx) => { await ctx.wa.sendVoice(ctx.chatId, a.text, ctx.msgKey); ctx.voiceSent = true; return 'Voice note sent.'; },
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
    desc: 'Schedule a reminder message in this chat. Give EITHER in_minutes OR at (ISO 8601 with timezone offset, e.g. 2026-10-01T09:00:00+05:00).',
    params: obj({ text: str('What to remind about'), in_minutes: num('Minutes from now'), at: str('Absolute ISO time') }, ['text']),
    run: (a, ctx) => {
      let due = a.in_minutes ? Date.now() + Number(a.in_minutes) * 60000 : Date.parse(a.at);
      if (!Number.isFinite(due) || due < Date.now() - 1000) throw new Error('Invalid or past time');
      const t = mem.addTask({ chatId: ctx.chatId, dueAt: due, text: a.text, createdBy: ctx.senderId });
      return `Reminder ${t.id} set for ${new Date(due).toISOString()}.`;
    },
  },
  list_reminders: {
    access: 'all', desc: 'List pending reminders in this chat.', params: obj({}),
    run: (_a, ctx) => mem.pendingTasks(ctx.chatId).map((t) => `${t.id}: ${new Date(t.dueAt).toISOString()} — ${t.text}`).join('\n') || 'No pending reminders.',
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
      return `Uptime ${up} min. Users ${Object.keys(mem.data.users).length}, chats ${Object.keys(mem.data.chats).length}, pending tasks ${mem.pendingTasks().length}, run #${mem.data.meta.runs}.\nProviders:\n` +
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
