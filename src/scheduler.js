// Scheduler v2: one-off + recurring reminders AND recurring "agent jobs" (Mizanora runs a prompt with all its tools
// at the scheduled time and sends the result — as text or as a voice note).
//   repeat: null | { type:'daily', time:'08:00' } | { type:'weekly', days:[1..7 (Mon=1)], time:'21:30' } | { type:'every', minutes:90 }
import { env } from './config.js';
import { mem } from './memory.js';

export const TZ = env('BOT_TIMEZONE', 'Asia/Karachi');

function tzParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] };
}
const offsetMs = (ms) => { const p = tzParts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
/** Wall-clock time in BOT_TIMEZONE → UTC epoch ms (DST-safe). */
export function zonedToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMs(guess);
  const off2 = offsetMs(t); if (off2 !== guess - t) t = guess - off2;
  return t;
}

export function parseTime(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`invalid time "${s}" — use HH:MM (24h)`);
  return [+m[1], +m[2]];
}

/** Next firing time strictly after `from`. */
export function nextOccurrence(repeat, from = Date.now()) {
  if (!repeat) return null;
  if (repeat.type === 'every') return from + Math.max(5, Number(repeat.minutes) || 60) * 60000;
  const [h, mi] = parseTime(repeat.time);
  const days = repeat.type === 'weekly' ? (repeat.days?.length ? repeat.days.map(Number) : [1, 2, 3, 4, 5, 6, 7]) : [1, 2, 3, 4, 5, 6, 7];
  const base = tzParts(from);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + i));
    const wd = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (!days.includes(wd)) continue;
    const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi);
    if (t > from + 1000) return t;
  }
  return from + 86400000;
}

export const describeRepeat = (r) => !r ? 'once' : r.type === 'every' ? `every ${r.minutes} min` : r.type === 'weekly' ? `weekly ${(r.days || []).join(',') || 'daily'} @ ${r.time}` : `daily @ ${r.time}`;

export function normalizeRepeat(r) {
  if (!r || typeof r !== 'object' || !r.type) return null;
  if (r.type === 'every') { const m = Number(r.minutes); if (!(m >= 5)) throw new Error('repeat.minutes must be at least 5'); return { type: 'every', minutes: Math.round(m) }; }
  if (r.type === 'daily') { parseTime(r.time); return { type: 'daily', time: r.time }; }
  if (r.type === 'weekly') { parseTime(r.time); return { type: 'weekly', days: (r.days || []).map(Number).filter((d) => d >= 1 && d <= 7), time: r.time }; }
  throw new Error('repeat.type must be daily, weekly or every');
}

/** First due time for a new schedule. */
export function firstDue({ in_minutes, at, repeat }) {
  if (in_minutes) return Date.now() + Number(in_minutes) * 60000;
  if (at) { const t = Date.parse(at); if (!Number.isFinite(t) || t < Date.now() - 1000) throw new Error('Invalid or past time'); return t; }
  if (repeat) return nextOccurrence(repeat);
  throw new Error('Give in_minutes, at, or a repeat schedule');
}

