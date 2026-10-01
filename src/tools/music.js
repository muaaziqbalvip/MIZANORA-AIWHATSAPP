// Music composer: the AI writes simple note text, this renders it (additive synth + drums) to WAV → MP3. No API needed.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PATHS } from '../config.js';

const SR = 22050, NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = (n) => { const m = /^([A-G])([#b]?)(-?\d)$/.exec(n); if (!m) return null; return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); };
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const VOICES = { piano: { h: [1, 0.5, 0.25, 0.12], a: 0.005, d: 3, s: 0 }, pad: { h: [1, 0.3, 0.15], a: 0.25, d: 0, s: 0.8 }, bass: { h: [1, 0.6, 0.2], a: 0.01, d: 0, s: 0.7 }, lead: { h: [1, 0.4, 0.3, 0.2, 0.1], a: 0.02, d: 0, s: 0.75 }, pluck: { h: [1, 0.7, 0.4, 0.2], a: 0.002, d: 6, s: 0 } };

export function parseTrack(txt, beat) { // "C4:1 E4:0.5 R:1 C4+E4+G4:2"
  const ev = []; let t = 0;
  for (const tok of String(txt).trim().split(/\s+/).filter(Boolean)) {
    const [ns, ds = '1'] = tok.split(':'); const d = Math.max(0.0625, Math.min(16, Number(ds) || 1));
    if (ns.toUpperCase() !== 'R') for (const n of ns.split('+')) { const m = midi(n); if (m != null) ev.push({ f: hz(m), s: t * beat, d: d * beat }); }
    t += d;
  } return ev;
}
function drumHit(buf, at, kind, vol) {
  const n = Math.floor((kind === 'k' ? 0.25 : kind === 's' ? 0.18 : 0.05) * SR), o = Math.floor(at * SR); let ph = 0;
  for (let i = 0; i < n && o + i < buf.length; i++) {
    const x = i / n, e = (1 - x) ** (kind === 'h' ? 3 : 2); let v;
    if (kind === 'k') { ph += (2 * Math.PI * (50 + 110 * (1 - x) ** 3)) / SR; v = Math.sin(ph); } else v = (Math.random() * 2 - 1) * (kind === 's' ? 0.8 : 0.5) + (kind === 's' ? 0.3 * Math.sin(i * 0.12) : 0);
    buf[o + i] += v * e * vol;
  }
}
export function render({ tempo = 100, tracks = [], drums = '', bars = 8 }) {
  const beat = 60 / Math.max(50, Math.min(200, Number(tempo) || 100)); let total = 0; const parts = [];
  for (const t of tracks.slice(0, 6)) { const ev = parseTrack(t.notes, beat), v = VOICES[t.instrument] || VOICES.piano; parts.push({ ev, v, g: Number(t.volume) || 0.5 }); for (const e of ev) total = Math.max(total, e.s + e.d); }
  const dur = Math.min(240, Math.max(total + 1, drums ? bars * 4 * beat : 0, 2)); const buf = new Float32Array(Math.ceil(dur * SR));
  for (const { ev, v, g } of parts) for (const e of ev) {
    const o = Math.floor(e.s * SR), n = Math.floor((e.d + 0.25) * SR);
    for (let i = 0; i < n && o + i < buf.length; i++) {
      const t = i / SR, rel = t > e.d ? Math.max(0, 1 - (t - e.d) / 0.25) : 1, atk = Math.min(1, t / v.a);
      const env = (v.d ? Math.exp(-v.d * t) : v.s) * atk * rel; let s = 0;
      v.h.forEach((a, k) => { s += a * Math.sin(2 * Math.PI * e.f * (k + 1) * t); });
      buf[o + i] += s * env * g * 0.25;
    }
  }
  if (drums) { const step = beat / 4; for (let b = 0; b * step * 16 < dur; b++) [...drums].forEach((c, i) => { if ('khs'.includes(c)) { const at = (b * drums.length + i) * step; if (at < dur) drumHit(buf, at, c, c === 'h' ? 0.25 : 0.6); } }); }
  let peak = 0.001; for (const x of buf) peak = Math.max(peak, Math.abs(x));
  const pcm = Buffer.alloc(44 + buf.length * 2); pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + buf.length * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(buf.length * 2, 40);
  buf.forEach((x, i) => pcm.writeInt16LE(Math.round((x / peak) * 0.85 * 32767), 44 + i * 2));
  return { wav: pcm, seconds: dur };
}
export async function composeMusic(a) {
  const { wav, seconds } = render(a); const base = String(a.title || 'song').replace(/[^\w-]+/g, '_').slice(0, 40) || 'song';
  const w = path.join(PATHS.workspace, `${base}.wav`), m = path.join(PATHS.workspace, `${base}.mp3`); fs.writeFileSync(w, wav);
  await new Promise((res, rej) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', w, '-b:a', '128k', m], { timeout: 60000 }, (e) => (e ? rej(e) : res())));
  fs.unlinkSync(w); return { file: m, seconds: Math.round(seconds) };
}

// ── Studio-quality songs (with vocals) via Gemini API "Lyria 3.5". Model IDs are from Google's docs (Sept 2026);
// override with LYRIA_MODELS. Falls back to the offline synth (composeMusic) if the API is unavailable.
import { keysFor, env, list } from '../config.js';
const LYRIA = list(env('LYRIA_MODELS', 'lyria-3.5,lyria-3-clip-preview'));
const hist = []; // timestamps for a simple hourly cap (each full song costs money)
export function pickAudio(json) { // tolerant parser: generateContent parts OR interactions steps
  let audio = null, text = '';
  const walk = (n) => { if (!n || typeof n !== 'object') return; const d = n.inlineData || n.inline_data; if (d?.data && /audio/.test(d.mimeType || d.mime_type || 'audio')) audio = audio || { b64: d.data, mime: d.mimeType || d.mime_type || 'audio/mpeg' }; if (n.type === 'audio' && n.data) audio = audio || { b64: n.data, mime: n.mime_type || 'audio/mpeg' }; if (typeof n.text === 'string') text += n.text + '\n'; for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v); };
  walk(json); return audio ? { ...audio, text: text.trim() } : null;
}
export async function generateSong({ prompt, lyrics = '', instrumental = false }, fetchImpl = fetch) {
  const keys = keysFor('gemini'); if (!keys.length) throw new Error('GEMINI_API_KEYS missing');
  const now = Date.now(); while (hist.length && now - hist[0] > 3600000) hist.shift();
  if (hist.length >= Number(env('SONG_MAX_PER_HOUR', '6'))) throw new Error('hourly song limit reached — try later');
  const text = `${prompt}${instrumental ? '\nInstrumental only, no vocals.' : ''}${lyrics ? `\nLyrics:\n${lyrics}` : ''}`.slice(0, 4000);
  let last = '';
  for (const model of LYRIA) for (const key of keys) {
    try {
      const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO', 'TEXT'] } }), signal: AbortSignal.timeout(170000) });
      if (!r.ok) { last = `${model} ${r.status}`; if (r.status === 404 || r.status === 400) break; continue; } // bad model → next model; 429/5xx → next key
      const a = pickAudio(await r.json()); if (!a) { last = `${model}: no audio in reply`; continue; }
      hist.push(Date.now()); return { buf: Buffer.from(a.b64, 'base64'), mime: a.mime, lyrics: a.text, model };
    } catch (e) { last = `${model}: ${e.message}`; }
  }
  throw new Error(`Lyria unavailable (${last})`);
}
