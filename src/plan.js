// Auto-start planner: decides which user agents should run, from Firestore data, and says WHY not when one is skipped.
export const CHANNELS = ['whatsapp', 'telegram', 'business'];
const UID = /^[A-Za-z0-9]{20,40}$/;
const hasLLM = (c = {}) => Object.entries(c).some(([k, v]) => v && /_API_KEYS?$/.test(k) && !/^(WHATSAPP|TAVILY|BRAVE|SERPER|POLLINATIONS)/.test(k));
export const channelsOf = (u) => { const c = (u.channels || []).filter((x) => CHANNELS.includes(x)); return c.length ? c : ['whatsapp']; }; // old users had no channel list → WhatsApp
// null = ready, otherwise a short human reason (shown on the website)
export function whyNot(u, ch, b) {
  if (!hasLLM(u.cfg)) return 'AI key missing (Agent tab → Gemini/Groq key daalein)';
  if (ch === 'whatsapp' && !u.cfg?.WHATSAPP_AGENT_API_KEY) return 'WhatsApp Agent API key missing';
  if (ch === 'telegram' && !u.cfg?.TELEGRAM_BOT_TOKEN) return 'Telegram bot token missing';
  if (ch === 'business' && !(b?.token && b?.phoneId && b?.appSecret)) return 'Business: token / phone ID / App Secret missing';
  return null;
}
export function plan(users, bizMap = {}, conf = {}) {
  const max = Math.min(200, Math.max(1, Number(conf.maxAgents) || 20)), include = [], report = {};
  for (const u of [...users].sort((a, b) => (a.created || 0) - (b.created || 0))) {
    if (!UID.test(u.uid || '')) continue;
    if (conf.paused) { report[u.uid] = 'Admin ne sab agents pause kiye hain'; continue; }
    if (u.status !== 'approved') { report[u.uid] = `status = ${u.status}`; continue; }
    if (u.ctl === 'stop') { report[u.uid] = 'Aap ne Stop kiya hua hai (Run dabayein)'; continue; }
    const reasons = [];
    for (const ch of channelsOf(u)) { const r = whyNot(u, ch, bizMap[u.uid]); if (r) reasons.push(`${ch}: ${r}`); else if (include.length < max) include.push({ uid: u.uid, ch }); else reasons.push(`${ch}: max agents limit (${max}) poori`); }
    report[u.uid] = reasons.length ? reasons.join(' | ') : 'queued ✅ — agla workflow run ya Run now par start';
  }
  return { include, report };
}
export const buildMatrix = (users, bizMap, conf) => ({ include: plan(users, bizMap, conf).include });
