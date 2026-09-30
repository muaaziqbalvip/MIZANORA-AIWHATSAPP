// Mizanora News: two hosts (Mizanora = female, Zain = male) present a 5-6 min bulletin as an MP4 (speaker cards + headlines over story imagery).
// Prepared in the background before 07:00 / 20:00 and sent to every subscriber.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { newsSearch, searchRaw } from './tools/search.js';
import { fetchUrl } from './tools/net.js';
import { complete } from './llm.js';
import { synthesize, tmpFile } from './voice.js';
import { mem } from './memory.js';
import { env } from './config.js';
import { TZ } from './scheduler.js';
import { log, warn } from './log.js';

const ex = promisify(execFile);
const TOPICS = env('NEWS_TOPICS', 'world headlines,Pakistan news,technology AI,business economy,sports').split(',').map((s) => s.trim());
const MINUTES = Number(env('NEWS_MINUTES', '5'));
export const SLOTS = ['07:00', '20:00'];

export function parseScript(s) {
  const m = String(s).replace(/```json|```/g, '').match(/\[[\s\S]*\]/); if (!m) return null;
  try { return JSON.parse(m[0]).filter((l) => l?.text && /^(mizanora|zain)$/i.test(l.who)).map((l) => ({ who: l.who.toLowerCase(), text: String(l.text).slice(0, 420), mood: l.mood || 'neutral', headline: String(l.headline || '').slice(0, 70) })); } catch { return null; }
}

export async function writeScript(minutes = MINUTES) {
  const facts = (await Promise.all(TOPICS.map((t) => newsSearch({ query: t, max_results: 5, recency: 'day' }).catch(() => '')))).join('\n\n').slice(0, 9000);
  const words = Math.round(minutes * 140);
  const out = await complete(`You write a live TV news bulletin for two presenters: "mizanora" (woman) and "zain" (man). Use ONLY the headlines given. Reply with ONLY a JSON array of about ${words / 35} lines: {"who":"mizanora|zain","text":"spoken text, Roman Urdu/English mix as Pakistanis speak, 1-3 short sentences","mood":"neutral|serious|caring|excited|calm","headline":"ENGLISH on-screen title, max 6 words (only on the first line of each story)"}. Total about ${words} words. Start with a greeting and the date, cover world, Pakistan, technology, business, sports; hosts hand over to each other naturally; end with a sign-off. No invented facts.`, `Today ${new Date().toLocaleDateString('en-GB', { timeZone: TZ, dateStyle: 'full' })}\n\n${facts}`, { maxTokens: 3500, temperature: 0.5 });
  const s = parseScript(out); if (!s?.length) throw new Error('news script generation failed'); return s;
}

const dur = async (f) => parseFloat((await ex('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout);
async function ogImage(url) { try { const h = await (await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0' } })).text(); const u = h.match(/property="og:image"[^>]*content="([^"]+)"/i)?.[1]; if (!u) return null; const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); const b = Buffer.from(await r.arrayBuffer()); return b.length > 5000 && b.length < 8e6 ? b : null; } catch { return null; } }

/** script → { video: Buffer, audio: Buffer, seconds } */
export async function renderBulletin(script, images = []) {
  const parts = [], tmp = [];
  try {
    let t = 0;
    for (const l of script) { const { ogg } = await synthesize(l.text, '', { mood: l.mood, gender: l.who === 'zain' ? 'male' : 'female' }); const f = tmpFile('ogg'); fs.writeFileSync(f, ogg); tmp.push(f); const d = await dur(f); parts.push({ ...l, f, t0: t, t1: t + d }); t += d; }
    const list = tmpFile('txt'); fs.writeFileSync(list, parts.map((p) => `file '${p.f}'`).join('\n')); tmp.push(list);
    const audio = tmpFile('m4a'); tmp.push(audio); await ex('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'aac', '-b:a', '64k', audio]);
    const imgs = images.slice(0, 6).map((b) => { const f = tmpFile('jpg'); fs.writeFileSync(f, b); tmp.push(f); return f; });
    let head = ''; const seg = []; // headline per time span
    for (const p of parts) { if (p.headline) seg.push({ h: p.headline, t0: p.t0 }); else if (!seg.length) seg.push({ h: 'MIZANORA NEWS', t0: 0 }); }
    seg.forEach((s, i) => { s.t1 = seg[i + 1]?.t0 ?? t; });
    const W = 1280, H = 720, args = ['-y', '-f', 'lavfi', '-i', `color=c=0x0b0d17:s=${W}x${H}:r=12:d=${t.toFixed(1)}`];
    imgs.forEach((f) => args.push('-loop', '1', '-t', (t / imgs.length + 1).toFixed(1), '-i', f));
    args.push('-i', audio);
    let fc = imgs.length ? imgs.map((_, i) => `[${i + 1}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p,setpts=PTS-STARTPTS[im${i}]`).join(';') + ';' + imgs.map((_, i) => `[im${i}]`).join('') + `concat=n=${imgs.length}:v=1:a=0,trim=duration=${t.toFixed(1)}[bg]` : `[0:v]null[bg]`;
    let cur = 'bg', n = 0; const box = (x, y, w, h, col, en) => { fc += `;[${cur}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${col}:t=fill${en ? `:enable='${en}'` : ''}[v${++n}]`; cur = `v${n}`; };
    const txt = (s, x, y, size, col, en) => { const f = tmpFile('txt'); fs.writeFileSync(f, s); tmp.push(f); fc += `;[${cur}]drawtext=textfile=${f}:x=${x}:y=${y}:fontsize=${size}:fontcolor=${col}${en ? `:enable='${en}'` : ''}[v${++n}]`; cur = `v${n}`; };
    box(0, 0, W, H, '0x0b0d17@0.35'); box(0, H - 210, W, 210, '0x0b0d17@0.82');
    for (const s of seg) txt(s.h.toUpperCase(), 60, H - 200, 44, 'white', `between(t,${s.t0.toFixed(2)},${s.t1.toFixed(2)})`);
    for (const [who, x, col] of [['mizanora', 60, '0x7c5cff'], ['zain', 300, '0x22d3ee']]) {
      box(x, H - 120, 220, 90, '0x1c2140@0.9'); for (const p of parts.filter((q) => q.who === who)) box(x, H - 126, 220, 6, col, `between(t,${p.t0.toFixed(2)},${p.t1.toFixed(2)})`);
      txt(who.toUpperCase(), x + 20, H - 92, 30, 'white');
    }
    txt('MIZANORA NEWS  •  LIVE', W - 380, 30, 26, 'white');
    const out = tmpFile('mp4'); tmp.push(out);
    await ex('ffmpeg', [...args, '-filter_complex', fc, '-map', `[${cur}]`, '-map', `${imgs.length + 1}:a`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out], { maxBuffer: 1e8, timeout: 600000 });
    return { video: fs.readFileSync(out), audio: fs.readFileSync(audio), seconds: Math.round(t) };
  } finally { tmp.forEach((f) => fs.rmSync(f, { force: true })); }
}

export async function buildBulletin() {
  const script = await writeScript(); const images = [];
  const r = await searchRaw({ query: 'top news today', max_results: 6, recency: 'day', news: true }).catch(() => null);
  for (const x of (r?.ranked || []).slice(0, 8)) { const b = await ogImage(x.url); if (b) images.push(b); if (images.length >= 6) break; }
  return renderBulletin(script, images);
}

const localNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { min: +p.hour * 60 + +p.minute, day: `${p.year}-${p.month}-${p.day}` }; };
let building = null;
export const subscribers = () => Object.keys(mem.data.meta.newsSubs || {});
export const setSub = (chatId, on) => { const m = mem.data.meta.newsSubs ||= {}; if (on) m[chatId] = 1; else delete m[chatId]; mem.touch(); };
export async function deliver(wa, chats, b) { for (const c of chats) { try { if (wa.sendVideo) await wa.sendVideo(c, b.video, `📺 Mizanora News — ${Math.round(b.seconds / 60)} min`); else { await wa.sendDocument(c, b.video, 'mizanora-news.mp4'); } } catch (e) { warn('news delivery failed:', e.message.slice(0, 80)); try { await wa.sendText(c, 'News video bhejne mein masla aaya.'); } catch {} } } }

/** every minute: start building 30 min before a slot, send exactly at the slot */
export function startNews(getWa) {
  return setInterval(async () => {
    const wa = getWa(); if (!wa || !subscribers().length) return;
    const { min, day } = localNow();
    for (const slot of SLOTS) {
      const [h, m] = slot.split(':').map(Number), at = h * 60 + m, key = `${day}-${slot}`;
      if (!building && min >= at - 30 && min < at && mem.data.meta.newsBuilt !== key) { mem.data.meta.newsBuilt = key; building = { key, p: buildBulletin().then((b) => { log(`news bulletin ready (${b.seconds}s)`); return b; }).catch((e) => { warn('news build failed:', e.message); return null; }) }; }
      if (building?.key === key && min >= at && min < at + 20 && mem.data.meta.newsSent !== key) { mem.data.meta.newsSent = key; const b = await building.p; building = null; if (b) await deliver(wa, subscribers(), b); mem.touch(); }
    }
  }, 60000).unref?.();
}
