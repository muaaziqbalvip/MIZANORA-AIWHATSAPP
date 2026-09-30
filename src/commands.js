// Slash commands shared by both transports.
//   returns: string (send it) | { rewrite } (run this text through the AI instead) | { handled:true } | null (not a command)
import { BOT, VOICE, BROWSER } from './config.js';
import { mem } from './memory.js';
import { providerStatus } from './llm.js';
import { executeTool } from './tools/index.js';
import { describeRepeat } from './scheduler.js';
import { browserAvailable } from './tools/browser.js';

const HELP = (owner) => `*${BOT.name}* — by ${BOT.developer}
Bas normal baat karein: text, voice note, photo, document ya location bhejein. Main khud tools use karta/karti hoon.

*Awaaz*
/voice on|off|auto — voice jawab
/voice male|female — awaaz ka andaaz
/speed 0.8–1.4 — bolne ki raftaar

*Search*
/search <sawal> — live web search
/research <sawal> — gehri research (kai sources, cited)
/news <topic> — taaza khabrein

*Automation*
/tasks — reminders aur scheduled kaam
/cancel <id> — koi reminder/kaam band
Likhein: "roz subah 8 baje weather aur news voice mein bhejo"
${owner ? `\n*Browser (owner)*\n/browse <url> — page kholo + screenshot + khulasa\n/shot <url> — sirf screenshot\n/task <maqsad> — browser khud kaam kare\n/closebrowser\n` : ''}
*Baaqi*
/memory · /forget <lafz> · /reset · /export · /status · /ping`;

export async function handleCommand(cmd, arg, c) {
  switch (cmd) {
    case 'help': case 'start': case 'commands': return HELP(c.isOwner);
    case 'ping': return 'pong 🏓';
    case 'reset': mem.resetChat(c.chatId); return 'History saaf kar di. ✅';

    case 'voice': {
      const v = arg.toLowerCase().trim();
      const map = { on: 'always', always: 'always', off: 'never', never: 'never', auto: 'auto' };
      if (map[v]) { mem.setPref(c.senderId, 'voice', map[v]); return `Voice mode → *${map[v]}*${map[v] === 'auto' ? ' (voice note ka jawab voice mein)' : ''}`; }
      if (v === 'male' || v === 'female') { mem.setPref(c.senderId, 'voiceGender', v); return `Awaaz → *${v === 'male' ? 'mard' : 'aurat'}* ✅ (agla voice note sun kar dekhein)`; }
      const p = mem.user(c.senderId).prefs;
      return `Voice mode: *${p.voice || 'auto'}* · awaaz: *${p.voiceGender || 'female'}* · speed: *${p.voiceSpeed || 1}*\nUse: /voice on|off|auto|male|female · /speed 1.1`;
    }
    case 'speed': {
      const n = parseFloat(arg);
      if (!(n >= 0.7 && n <= 1.5)) return 'Speed 0.7 se 1.5 ke beech likhein, jaise /speed 1.1 (1 = normal).';
      mem.setPref(c.senderId, 'voiceSpeed', n); return `Bolne ki raftaar → *${n}x* ✅`;
    }

    case 'memory': { const u = mem.user(c.senderId); return u.facts.length ? `Aap ke baare mein:\n${u.facts.map((f) => `• ${f.text}`).join('\n')}` : 'Abhi aap ke baare mein kuch save nahi hai.'; }
    case 'forget': return arg ? `${mem.forgetFact(c.senderId, arg)} baat(ein) bhool gaya/gayi.` : 'Use: /forget <lafz>';
    case 'export': {
      const u = mem.user(c.senderId);
      const data = { exportedAt: new Date().toISOString(), name: u.name, facts: u.facts, prefs: u.prefs, summary: mem.chat(c.chatId).summary, tasks: mem.pendingTasks(c.chatId) };
      await c.wa.sendDocument(c.chatId, Buffer.from(JSON.stringify(data, null, 2)), 'mizanora-memory.json', c.msgKey);
      return { handled: true };
    }

    case 'tasks': case 'schedules': case 'reminders': {
      const list = mem.pendingTasks(c.chatId);
      return list.length ? list.map((t) => `*${t.id}* ${t.kind === 'agent' ? '🤖' : '⏰'} ${describeRepeat(t.repeat)}${t.voice ? ' 🔊' : ''}\n${t.text.slice(0, 100)}`).join('\n\n') + '\n\nBand karne ke liye: /cancel <id>' : 'Koi pending reminder ya scheduled kaam nahi.';
    }
    case 'cancel': return arg ? (mem.cancelTask(arg.trim()) ? 'Band kar diya. ✅' : 'Is id ka koi pending kaam nahi mila.') : 'Use: /cancel <id> (ids /tasks mein hain)';

    case 'status': {
      if (!c.isOwner) return null;
      return `Uptime ${Math.round(process.uptime() / 60)} min · run #${mem.data.meta.runs} · users ${Object.keys(mem.data.users).length} · pending tasks ${mem.pendingTasks().length}\n` +
        `Voice engines: ${VOICE.ttsOrder.join(' → ')} · Browser: ${browserAvailable() ? `on (max ${BROWSER.maxSteps} steps)` : 'off'}\n` +
        providerStatus().map((p) => `• ${p.id}: ${p.keys} key(s)${p.cooling ? ' (cooling)' : ''}`).join('\n');
    }

    // ── shortcuts that go through the AI with an explicit instruction ──
    case 'search': case 's': return arg ? { rewrite: `Search the live web and answer this precisely, mentioning sources: ${arg}` } : 'Use: /search <sawal>';
    case 'research': case 'deep': return arg ? { rewrite: `Use deep_research (depth normal) to research this thoroughly and give a cited answer: ${arg}` } : 'Use: /research <sawal>';
    case 'news': return { rewrite: `Use news_search for the latest news about: ${arg || 'Pakistan and world headlines'}. Give the top stories in 1 line each with source and how old they are.` };

    // ── browser (owner) ──
    case 'browse': case 'open':
      if (!c.isOwner) return 'Browser sirf owner use kar sakta hai.';
      return arg ? { rewrite: `Use the browse tool with screenshot=true on: ${arg}. Then summarise what the page shows in a few lines.` } : 'Use: /browse <url>';
    case 'shot': case 'screenshot': {
      if (!c.isOwner) return 'Browser sirf owner use kar sakta hai.';
      if (!arg) return 'Use: /shot <url>';
      const out = await executeTool('screenshot', { url: arg.trim() }, c);
      return /^Error/.test(out) ? `Screenshot nahi ho saka: ${out.slice(0, 160)}` : { handled: true };
    }
    case 'task':
      if (!c.isOwner) return 'Browser sirf owner use kar sakta hai.';
      return arg ? { rewrite: `Use browser_task to accomplish this goal, then report the result: ${arg}` } : 'Use: /task <maqsad>, jaise /task daraz par sab se sasta 128GB phone dhundo';
    case 'closebrowser': return c.isOwner ? executeTool('browser_close', {}, c) : null;
    default: return null;
  }
}
