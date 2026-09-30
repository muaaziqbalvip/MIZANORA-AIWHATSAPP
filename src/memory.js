// Persistent memory: user profiles, per-chat history, task queue, system log.
// Stored as memory_store/bot_memory.json (atomic writes) so the next GitHub Actions
// runner can restore exactly where the previous one stopped.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { log, warn } from './log.js';

const MAX_HISTORY = 60;      // messages kept per chat before compaction is requested
const KEEP_AFTER_COMPACT = 20;
const MAX_FACTS = 80;
const MAX_LOGS = 200;

const empty = () => ({
  version: 1,
  users: {},   // jid -> { name, facts:[{t,text}], prefs:{voice:'auto'|'always'|'never'}, firstSeen, lastSeen, messages }
  chats: {},   // chatId -> { summary, history:[{role,content,t}] }
  tasks: [],   // { id, chatId, dueAt, text, createdBy, done }
  logs: [],    // system log ring buffer
  meta: { startedAt: null, lastSavedAt: null, runs: 0, lastShutdown: null },
});

class Memory {
  constructor() { this.data = empty(); this.dirty = false; this.timer = null; }

  load() {
    try {
      if (fs.existsSync(PATHS.memoryFile)) {
        const parsed = JSON.parse(fs.readFileSync(PATHS.memoryFile, 'utf8'));
        this.data = { ...empty(), ...parsed, meta: { ...empty().meta, ...(parsed.meta || {}) } };
        log(`Memory restored: ${Object.keys(this.data.users).length} users, ${Object.keys(this.data.chats).length} chats, ${this.data.tasks.filter((t) => !t.done).length} pending tasks`);
      } else {
        log('No previous memory found — starting fresh.');
      }
    } catch (e) {
      warn('Memory file unreadable, keeping a backup and starting fresh:', e.message);
      try { fs.copyFileSync(PATHS.memoryFile, PATHS.memoryFile + `.corrupt-${Date.now()}`); } catch {}
      this.data = empty();
    }
    this.data.meta.runs += 1;
    this.data.meta.startedAt = new Date().toISOString();
    this.touch();
  }

  touch() { this.dirty = true; }

  save() {
    try {
      this.data.meta.lastSavedAt = new Date().toISOString();
      const tmp = PATHS.memoryFile + '.tmp';
      fs.mkdirSync(path.dirname(PATHS.memoryFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, PATHS.memoryFile);
      this.dirty = false;
    } catch (e) { warn('Memory save failed:', e.message); }
  }

  startAutosave(everySec) {
    this.timer = setInterval(() => { if (this.dirty) this.save(); }, everySec * 1000);
    this.timer.unref?.();
  }
  stopAutosave() { if (this.timer) clearInterval(this.timer); }

  // ── system log ──
  logEvent(msg) {
    this.data.logs.push({ t: new Date().toISOString(), msg: String(msg).slice(0, 400) });
    if (this.data.logs.length > MAX_LOGS) this.data.logs.splice(0, this.data.logs.length - MAX_LOGS);
    this.touch();
  }

  // ── users ──
  user(jid, name) {
    const key = String(jid);
    let u = this.data.users[key];
    if (!u) {
      u = this.data.users[key] = { name: name || '', facts: [], prefs: { voice: 'auto' }, firstSeen: new Date().toISOString(), lastSeen: null, messages: 0 };
    }
    if (name && name !== u.name) u.name = name;
    u.lastSeen = new Date().toISOString();
    u.messages += 1;
    this.touch();
    return u;
  }

  addFact(jid, text) {
    const u = this.user(jid);
    text = String(text).trim().slice(0, 300);
    if (!text) return false;
    if (u.facts.some((f) => f.text.toLowerCase() === text.toLowerCase())) return false;
    u.facts.push({ t: new Date().toISOString(), text });
    if (u.facts.length > MAX_FACTS) u.facts.splice(0, u.facts.length - MAX_FACTS);
    this.touch();
    return true;
  }

  forgetFact(jid, needle) {
    const u = this.data.users[String(jid)];
    if (!u) return 0;
    const before = u.facts.length;
    const n = String(needle).toLowerCase();
    u.facts = u.facts.filter((f) => !f.text.toLowerCase().includes(n));
    this.touch();
    return before - u.facts.length;
  }

  setPref(jid, key, value) { this.user(jid).prefs[key] = value; this.touch(); }

  // ── chat history ──
  chat(chatId) {
    if (!this.data.chats[chatId]) this.data.chats[chatId] = { summary: '', history: [] };
    return this.data.chats[chatId];
  }
  addMessage(chatId, role, content) {
    const c = this.chat(chatId);
    c.history.push({ role, content: String(content).slice(0, 4000), t: Date.now() });
    this.touch();
  }
  needsCompaction(chatId) { return this.chat(chatId).history.length > MAX_HISTORY; }
  compactionInput(chatId) {
    const c = this.chat(chatId);
    return { summary: c.summary, old: c.history.slice(0, Math.max(0, c.history.length - KEEP_AFTER_COMPACT)) };
  }
  applyCompaction(chatId, newSummary) {
    const c = this.chat(chatId);
    c.summary = String(newSummary).slice(0, 3000);
    c.history = c.history.slice(-KEEP_AFTER_COMPACT);
    this.touch();
  }
  resetChat(chatId) { this.data.chats[chatId] = { summary: '', history: [] }; this.touch(); }

  // ── tasks / reminders ──
  addTask({ chatId, dueAt, text, createdBy }) {
    const t = { id: Math.random().toString(36).slice(2, 8), chatId, dueAt, text: String(text).slice(0, 500), createdBy, done: false };
    this.data.tasks.push(t);
    this.touch();
    return t;
  }
  dueTasks(now = Date.now()) { return this.data.tasks.filter((t) => !t.done && t.dueAt <= now); }
  pendingTasks(chatId) { return this.data.tasks.filter((t) => !t.done && (!chatId || t.chatId === chatId)); }
  finishTask(id) {
    const t = this.data.tasks.find((x) => x.id === id);
    if (t) { t.done = true; this.touch(); }
    // keep the array small
    if (this.data.tasks.length > 300) this.data.tasks = this.data.tasks.filter((x) => !x.done).concat(this.data.tasks.filter((x) => x.done).slice(-50));
  }
  cancelTask(id) { const t = this.data.tasks.find((x) => x.id === id && !x.done); if (t) { t.done = true; this.touch(); return true; } return false; }
}

export const mem = new Memory();
