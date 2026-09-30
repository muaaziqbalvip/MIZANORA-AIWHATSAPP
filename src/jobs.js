// Job runner: fires due reminders and agent tasks (kept apart from scheduler.js so tools can import the pure time helpers without a cycle).
import { mem } from './memory.js';
import { respond } from './brain.js';
import { nextOccurrence } from './scheduler.js';
import { log, warn } from './log.js';

// ── runner ───────────────────────────────────────────────────────────────────────────
export function startScheduler(getWa, { tickMs = 20000 } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    const wa = getWa(); if (!wa || busy) return;
    busy = true;
    try {
      for (const t of mem.dueTasks()) {
        try { await fire(t, wa); }
        catch (e) { warn(`task ${t.id} failed:`, e.message); t.failures = (t.failures || 0) + 1; if (t.failures >= 3) { mem.finishTask(t.id); mem.logEvent(`task ${t.id} disabled after 3 failures`); } else t.dueAt = Date.now() + 5 * 60000; mem.touch(); continue; }
        if (t.repeat) { t.dueAt = nextOccurrence(t.repeat, Math.max(Date.now(), t.dueAt)); t.runs = (t.runs || 0) + 1; t.failures = 0; mem.touch(); }
        else mem.finishTask(t.id);
      }
    } finally { busy = false; }
  }, tickMs);
  timer.unref?.();
  return timer;
}

async function fire(t, wa) {
  if (t.kind === 'agent') {
    const ctx = { chatId: t.chatId, senderId: t.chatId, senderCandidates: [t.chatId], isGroup: false, isOwner: true, isGroupAdmin: false, msgKey: null, quotedKey: null, wa, voiceSent: false, scheduled: true };
    const reply = await respond({ text: `[Scheduled task, running automatically now] ${t.text}`, voiceReply: !!t.voice, ctx });
    if (reply) {
      if (t.voice) { try { await wa.sendVoice(t.chatId, reply, { mood: ctx.replyMood }); return; } catch (e) { warn('scheduled voice failed, sending text:', e.message.slice(0, 80)); } }
      await wa.sendText(t.chatId, reply);
    }
    log(`agent task ${t.id} delivered`);
    return;
  }
  const msg = `⏰ Yaad dehani: ${t.text}`;
  if (t.voice) { try { await wa.sendVoice(t.chatId, `Yaad dehani. ${t.text}`, { mood: 'caring' }); return; } catch { /* fall through to text */ } }
  await wa.sendText(t.chatId, msg);
}
