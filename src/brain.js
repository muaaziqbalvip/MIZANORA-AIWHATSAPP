// The agent brain: builds context (profile + summary + history), runs the tool-calling loop
// across the multi-provider router, stores the exchange in persistent memory.
import { chat, complete } from './llm.js';
import { mem } from './memory.js';
import { buildSystemPrompt } from './prompt.js';
import { toolSpecs, toolNames, executeTool } from './tools/index.js';
import { describeImage } from './vision.js';
import { extractMood, inferMood } from './emotion.js';
import { log, warn } from './log.js';

const MAX_STEPS = 8;
const compacting = new Set();

async function compactIfNeeded(chatId) {
  if (!mem.needsCompaction(chatId) || compacting.has(chatId)) return;
  compacting.add(chatId);
  try {
    const { summary, old } = mem.compactionInput(chatId);
    const transcript = old.map((m) => `${m.role === 'user' ? 'U' : 'A'}: ${m.content}`).join('\n').slice(0, 14000);
    const s = await complete(
      'You maintain a compact long-term memory of a chat. Merge the previous summary with the new transcript into ONE updated summary (max 220 words): key facts about the people, decisions, ongoing tasks, preferences, unresolved questions. Keep the original language mix. No preamble.',
      `Previous summary:\n${summary || '(none)'}\n\nNew transcript:\n${transcript}`,
      { maxTokens: 500 },
    );
    if (s.trim()) { mem.applyCompaction(chatId, s.trim()); log(`Compacted history of ${chatId}`); }
  } catch (e) { warn('history compaction failed:', e.message); }
  finally { compacting.delete(chatId); }
}

/**
 * respond({ text, image?, senderName, voiceReply, langHint, ctx })
 *   ctx: { chatId, senderId, isOwner, isGroup, isGroupAdmin, msgKey, quotedKey, wa }
 * → reply string ('' when the reply was already delivered by a tool, e.g. a voice note)
 */
export async function respond({ text, image = null, senderName = '', voiceReply = false, langHint = '', ctx }) {
  const user = mem.user(ctx.senderId, senderName);
  const chatData = mem.chat(ctx.chatId);
  const tools = toolSpecs(ctx);

  let userText = text || '';
  if (image) {
    try {
      const d = await describeImage(image, text);
      userText = `[The user sent an image. Image analysis: ${d}]${text ? `\nCaption: ${text}` : ''}`;
    } catch (e) {
      warn('vision failed:', e.message);
      userText = `[The user sent an image, but image analysis is unavailable right now (${e.message.slice(0, 80)}).]${text ? `\nCaption: ${text}` : ''}`;
    }
  }
  const labelled = ctx.isGroup && senderName ? `[${senderName}]: ${userText}` : userText;

  const system = buildSystemPrompt({ extra: ctx.bizPrompt || '', user, chatSummary: chatData.summary, isOwner: ctx.isOwner, isGroup: ctx.isGroup, voiceReply, langHint, tools: toolNames(ctx) });
  const messages = [
    { role: 'system', content: system },
    ...chatData.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: labelled },
  ];

  let reply = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    const { message, provider } = await chat({ messages, tools: last ? null : tools });
    const calls = message.tool_calls || [];
    if (!calls.length) { reply = message.content || ''; log(`reply via ${provider} after ${step} tool round(s)`); break; }

    messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls });
    for (const c of calls) {
      const name = c.function?.name;
      log(`tool → ${name} ${String(c.function?.arguments || '').slice(0, 160)}`);
      const result = await executeTool(name, c.function?.arguments, ctx);
      messages.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }

  // mood tag ("[mood: happy] …") drives the voice; always strip it from what is stored / sent as text
  const tagged = extractMood(reply);
  reply = tagged.text;
  ctx.replyMood = tagged.mood || (voiceReply && reply ? inferMood(reply) : '');

  if (!reply && !ctx.voiceSent) reply = 'Maazrat, abhi jawab tayyar nahi ho saka. Dobara koshish karein.';

  mem.addMessage(ctx.chatId, 'user', labelled);
  if (reply) mem.addMessage(ctx.chatId, 'assistant', reply);
  else if (ctx.voiceSent) mem.addMessage(ctx.chatId, 'assistant', '(sent a voice note)');
  compactIfNeeded(ctx.chatId);
  return reply;
}
