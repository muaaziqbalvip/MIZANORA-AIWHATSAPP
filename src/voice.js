// Voice pipeline: incoming voice note → text (Whisper / Gemini) ; text → native WhatsApp voice note (ogg/opus, ptt).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { VOICE, keysFor, env, GEMINI_STT_MODELS } from './config.js';
import { log, warn } from './log.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────
export function detectScript(text) {
  const t = String(text || '');
  const ar = (t.match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length;
  const dev = (t.match(/[\u0900-\u097F]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  const total = ar + dev + lat || 1;
  if (ar / total > 0.4) return 'ur';
  if (dev / total > 0.4) return 'hi';
  return 'en';
}

const LANG_MAP = { urdu: 'ur', hindi: 'hi', english: 'en', ur: 'ur', hi: 'hi', en: 'en', punjabi: 'ur', arabic: 'ur', pashto: 'ur', sindhi: 'ur' };
export const normLang = (l) => LANG_MAP[String(l || '').toLowerCase()] || '';

function run(cmd, args, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0); let errb = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    p.stderr.on('data', (d) => { errb += d.toString().slice(-2000); });
    p.on('error', (e) => { clearTimeout(to); reject(new Error(`${cmd} not available: ${e.message}`)); });
    p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${errb.slice(-300)}`)); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

const tmpFile = (ext) => path.join(os.tmpdir(), `mz-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);

// ── Speech to text ───────────────────────────────────────────────────────────────────
async function whisperCompat(base, key, model, buf, filename, mime) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(90000) });
  const txt = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${txt.slice(0, 200)}`), { status: res.status });
  const j = JSON.parse(txt);
  return { text: (j.text || '').trim(), language: normLang(j.language) };
}

const deadSttModels = new Set();
async function geminiTranscribe(key, buf, mime) {
  let lastErr;
  for (const model of GEMINI_STT_MODELS) {
    if (deadSttModels.has(model)) continue;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime.split(';')[0], data: buf.toString('base64') } }, { text: 'Transcribe this audio exactly as spoken, in its original language and script (Urdu in Urdu script, Hindi in Devanagari). Output only the transcript, nothing else.' }] }] }),
      signal: AbortSignal.timeout(90000),
    });
    const txt = await res.text();
    if (res.status === 404) deadSttModels.add(model);
    if (!res.ok) { lastErr = Object.assign(new Error(`${model} ${res.status} ${txt.slice(0, 160)}`), { status: res.status }); continue; } // next model on the ladder
    const t = JSON.parse(txt)?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
    if (t) return { text: t, language: detectScript(t) };
  }
  throw lastErr || new Error('gemini: empty transcript');
}

/** transcribe(buffer, mime) → { text, language } — tries every configured STT provider and key. */
export async function transcribe(buf, mime = 'audio/ogg') {
  const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : mime.includes('wav') ? 'wav' : 'ogg';
  const errors = [];
  for (const prov of VOICE.sttOrder) {
    const keys = keysFor(prov);
    for (const key of keys) {
      try {
        let r;
        if (prov === 'groq') r = await whisperCompat('https://api.groq.com/openai/v1', key, VOICE.sttGroqModel, buf, `voice.${ext}`, mime);
        else if (prov === 'openai') r = await whisperCompat('https://api.openai.com/v1', key, env('STT_OPENAI_MODEL', 'whisper-1'), buf, `voice.${ext}`, mime);
        else if (prov === 'gemini') r = await geminiTranscribe(key, buf, mime);
        else continue;
        if (r.text) return r;
      } catch (e) {
        errors.push(`${prov}: ${e.message.slice(0, 100)}`);
        if (e.status && e.status !== 429 && e.status < 500 && e.status !== 401) break; // bad request → next provider
      }
    }
  }
  throw new Error('Speech-to-text failed: ' + (errors.join(' | ') || 'no STT key configured (GROQ_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)'));
}

/** Extract audio from a video file buffer and transcribe it. */
export async function transcribeVideo(buf) {
  const inp = tmpFile('mp4'); const out = tmpFile('mp3');
  fs.writeFileSync(inp, buf);
  try {
    await run('ffmpeg', ['-y', '-i', inp, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]);
    return await transcribe(fs.readFileSync(out), 'audio/mpeg');
  } finally { fs.rmSync(inp, { force: true }); fs.rmSync(out, { force: true }); }
}

// ── Text to speech ───────────────────────────────────────────────────────────────────
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500);
}

async function edgeTts(text, lang) {
  const voice = VOICE.ttsVoices[lang] || VOICE.ttsVoices.en;
  const txt = tmpFile('txt'); const mp3 = tmpFile('mp3');
  fs.writeFileSync(txt, text, 'utf8');
  try {
    await run('edge-tts', ['--voice', voice, '--rate', VOICE.ttsRate, '--file', txt, '--write-media', mp3], { timeoutMs: 90000 });
    return fs.readFileSync(mp3);
  } finally { fs.rmSync(txt, { force: true }); fs.rmSync(mp3, { force: true }); }
}

async function openaiTts(text) {
  const key = keysFor('openai')[0];
  if (!key) throw new Error('no OPENAI key for TTS');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env('TTS_OPENAI_MODEL', 'gpt-4o-mini-tts'), voice: env('TTS_OPENAI_VOICE', 'nova'), input: text, response_format: 'mp3' }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Convert any audio buffer to WhatsApp voice-note format (ogg / opus, mono). */
export async function toOggOpus(buf) {
  const inp = tmpFile('mp3'); const out = tmpFile('ogg');
  fs.writeFileSync(inp, buf);
  try {
    await run('ffmpeg', ['-y', '-i', inp, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-application', 'voip', out]);
    return fs.readFileSync(out);
  } finally { fs.rmSync(inp, { force: true }); fs.rmSync(out, { force: true }); }
}

/** synthesize(text) → { ogg:Buffer, lang } */
export async function synthesize(text, langHint = '') {
  const clean = cleanForSpeech(text);
  if (!clean) throw new Error('nothing to speak');
  const lang = langHint && VOICE.ttsVoices[langHint] ? (detectScript(clean) === 'en' && langHint !== 'en' ? 'en' : langHint) : detectScript(clean);
  let mp3;
  try { mp3 = await edgeTts(clean, lang); }
  catch (e) {
    warn('edge-tts failed, trying OpenAI TTS:', e.message);
    mp3 = await openaiTts(clean);
  }
  log(`TTS ok (${lang}, ${clean.length} chars)`);
  return { ogg: await toOggOpus(mp3), lang };
}
