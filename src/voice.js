// Voice pipeline: incoming voice note → text (Whisper / Gemini) ; text → native WhatsApp voice note (ogg/opus, ptt).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { VOICE, keysFor, env, GEMINI_STT_MODELS } from './config.js';
import { extractMood, inferMood, moodParams } from './emotion.js';
import { complete } from './llm.js';
import { mem } from './memory.js';
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
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Gemini speech-to-text: every model on the ladder, each retried with backoff on 429/5xx ("high demand" 503s are transient). */
async function geminiTranscribe(key, buf, mime) {
  const errs = [];
  const body = JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime.split(';')[0], data: buf.toString('base64') } }, { text: 'Transcribe this audio exactly as spoken, in its original language and script (Urdu in Urdu script, Hindi in Devanagari). Output only the transcript, nothing else.' }] }] });
  for (const model of GEMINI_STT_MODELS) {
    if (deadSttModels.has(model)) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      let status = 0;
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(60000),
        });
        status = res.status;
        if (res.ok) {
          const t = (await res.json())?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
          if (t) return { text: t, language: detectScript(t) };
          errs.push(`${model} empty`); break;
        }
        if (status === 404) deadSttModels.add(model);
      } catch { status = 0; }
      errs.push(`${model} ${status || 'timeout'}`);
      if (status === 429 || status >= 500 || status === 0) { if (attempt < 2) { await sleepMs(1500 * (attempt + 1)); continue; } }
      break; // 4xx (bad request / dead model) → next model on the ladder
    }
  }
  warn('Gemini STT failed on every model:', errs.join(', '));
  throw Object.assign(new Error(`gemini: ${errs.slice(-4).join(', ')}`), { status: 503 });
}

/** Best-effort: mono 16 kHz, rumble removed, loudness evened out → noticeably better Urdu/Hindi recognition on quiet or noisy notes. */
async function cleanForStt(buf, mime) {
  if (buf.length < 2000 || buf.length > 12 * 1024 * 1024) return { buf, mime };
  const inp = tmpFile('in'); const out = tmpFile('ogg');
  try {
    fs.writeFileSync(inp, buf);
    await run('ffmpeg', ['-y', '-i', inp, '-vn', '-ac', '1', '-ar', '16000', '-af', 'highpass=f=80,loudnorm=I=-18:TP=-2', '-c:a', 'libopus', '-b:a', '32k', out], { timeoutMs: 45000 });
    const cleaned = fs.readFileSync(out);
    return cleaned.length > 500 ? { buf: cleaned, mime: 'audio/ogg' } : { buf, mime };
  } catch { return { buf, mime }; }
  finally { fs.rmSync(inp, { force: true }); fs.rmSync(out, { force: true }); }
}

/** transcribe(buffer, mime) → { text, language } — tries every configured STT provider and key. */
export async function transcribe(buf, mime = 'audio/ogg') {
  ({ buf, mime } = await cleanForStt(buf, mime));
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

// ── Text to speech (v2) ──────────────────────────────────────────────────────────────
// Pipeline: mood tag → clean → (Roman Urdu → Urdu script) → engine ladder (Gemini expressive TTS → edge-tts → OpenAI)
//           → ffmpeg: trim silence, loudness-normalise, optional speed → WhatsApp ogg/opus.
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut long text at a sentence end (۔ . ! ? ؟) instead of mid-word. */
export function speechExcerpt(t, max = VOICE.maxChars || 1800) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf('۔'), cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('؟'), cut.lastIndexOf('।'));
  return (i > max * 0.5 ? cut.slice(0, i + 1) : cut).trim();
}

// Common Roman-Urdu/Hindi function words: enough to tell "kya haal hai" apart from English.
const ROMAN_WORDS = new Set(('hai hain ho hoon hun tha thi the kya kyun kyon kaise kaisa kaisi kahan kab kaun kon nahi nahin nahi na ji jee haan han acha achha theek thik bilkul ' +
  'main mein mai mujhe mujh hum ham aap apka apki apke aapka aapki tum tumhara tera meri mera mere unka uska iska yeh ye woh wo is us ko ka ki ke se par pe tak bhi hi sirf ' +
  'aur ya lekin magar kyunke kyunki agar to toh phir abhi ab baad pehle kal aaj raat subah kuch sab bohat bahut zyada kam thoda bara chota naya purana ' +
  'kar karo karna kiya kiye karein karen ho gaya gayi gaye raha rahi rahe sakta sakti sakte chahiye chahta chahti dena diya lena liya batao bata bhej bhejo dekho dekh sun suno ' +
  'shukriya maazrat meherbani salam kaam paisa ghar din waqt log yaar bhai behen').split(/\s+/));

export function isRomanUrdu(text) {
  const words = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 3) return false;
  const hits = words.filter((w) => ROMAN_WORDS.has(w)).length;
  return hits / words.length >= 0.28 || hits >= 4;
}

const translitCache = new Map();
/** Roman Urdu/Hindi → native script so the neural voice pronounces it correctly. Falls back to the original text. */
export async function toNativeScript(text, target = 'ur') {
  const key = `${target}|${text}`;
  if (translitCache.has(key)) return translitCache.get(key);
  const scriptName = target === 'hi' ? 'Hindi (Devanagari script)' : 'Urdu (Urdu script, not Roman)';
  try {
    const out = await complete(
      `You convert Roman-script Urdu/Hindi (and mixed English) text into ${scriptName} for a text-to-speech engine. Keep the meaning and wording; do NOT translate to another language; keep English words in English letters; write digits as spoken words in the target language when short; output ONLY the converted text.`,
      text, { maxTokens: 900, temperature: 0.1 },
    );
    const clean = out.trim().replace(/^["“]|["”]$/g, '');
    if (clean && detectScript(clean) !== 'en') { translitCache.set(key, clean); if (translitCache.size > 200) translitCache.delete(translitCache.keys().next().value); return clean; }
  } catch (e) { warn('romanisation for TTS failed (speaking as-is):', e.message.slice(0, 80)); }
  return text;
}

async function edgeTts(text, lang, { mood, gender }) {
  const table = gender === 'male' ? VOICE.ttsVoicesMale : VOICE.ttsVoices;
  const voice = table[lang] || VOICE.ttsVoices[lang] || VOICE.ttsVoices.en;
  const mp = moodParams(mood);
  const pct = (v) => parseInt(String(v).replace('%', ''), 10) || 0;
  const rate = pct(mp.rate) + pct(VOICE.ttsRate); // the user's /speed is applied afterwards in ffmpeg (atempo) for every engine
  const txt = tmpFile('txt'); const mp3 = tmpFile('mp3');
  fs.writeFileSync(txt, text, 'utf8');
  try {
    await run('edge-tts', ['--voice', voice, `--rate=${rate >= 0 ? '+' : ''}${rate}%`, `--pitch=${mp.pitch}`, `--volume=${mp.volume}`, '--file', txt, '--write-media', mp3], { timeoutMs: 90000 });
    return { buf: fs.readFileSync(mp3), inputArgs: [] };
  } finally { fs.rmSync(txt, { force: true }); fs.rmSync(mp3, { force: true }); }
}

const deadTtsModels = new Set();
let geminiTtsCooldown = 0;
/** Gemini TTS: expressive, follows a natural-language style ("say warmly…"), speaks Urdu/Hindi/English. Returns raw PCM 24 kHz. */
async function geminiTts(text, lang, { mood, gender }) {
  const keys = keysFor('gemini');
  if (!keys.length) throw new Error('no Gemini key');
  if (Date.now() < geminiTtsCooldown) throw new Error('gemini tts cooling down');
  const voiceName = VOICE.geminiVoice[gender === 'male' ? 'm' : 'f'];
  const langName = { ur: 'Urdu', hi: 'Hindi', en: 'English' }[lang] || 'English';
  const prompt = `Read the following ${langName} text aloud ${moodParams(mood).style}. Speak naturally like a real person on a WhatsApp voice note, with natural pauses; do not add or skip any words.\n\n${text}`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } });
  const errs = []; let quota = 0; let tried = 0;
  for (const model of VOICE.geminiTtsModels) {
    if (deadTtsModels.has(model)) continue;
    for (const key of keys) {
      tried++;
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(60000) });
        if (r.status === 429) { quota++; errs.push(`${model} 429`); continue; }
        if (r.status === 404) { deadTtsModels.add(model); errs.push(`${model} 404`); break; }
        if (!r.ok) { errs.push(`${model} ${r.status}`); break; }
        const part = (await r.json())?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
        const b64 = part?.inlineData?.data || part?.inline_data?.data;
        if (!b64) { errs.push(`${model} no audio`); break; }
        const mime = part.inlineData?.mimeType || part.inline_data?.mime_type || 'audio/L16;rate=24000';
        const rate = (mime.match(/rate=(\d+)/) || [])[1] || '24000';
        return { buf: Buffer.from(b64, 'base64'), inputArgs: ['-f', 's16le', '-ar', rate, '-ac', '1'] };
      } catch (e) { errs.push(`${model} ${e.name}`); break; }
    }
  }
  if (quota && quota >= tried) geminiTtsCooldown = Date.now() + 5 * 60000;
  throw new Error(`gemini tts: ${errs.slice(-3).join(', ') || 'failed'}`);
}

async function openaiTts(text, _lang, { gender }) {
  const key = keysFor('openai')[0];
  if (!key) throw new Error('no OPENAI key for TTS');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env('TTS_OPENAI_MODEL', 'gpt-4o-mini-tts'), voice: env('TTS_OPENAI_VOICE', gender === 'male' ? 'onyx' : 'nova'), input: text, response_format: 'mp3' }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), inputArgs: [] };
}

const ENGINES = { gemini: geminiTts, edge: edgeTts, openai: openaiTts };

/** ffmpeg filter chain: clean low rumble, trim leading/trailing silence, even out loudness, optional speed. */
export function speechFilter(speed = 1) {
  const f = ['highpass=f=70', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1', 'areverse', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.25', 'areverse'];
  const sp = Math.min(Math.max(Number(speed) || 1, 0.7), 1.5);
  if (Math.abs(sp - 1) > 0.02) f.push(`atempo=${sp.toFixed(2)}`);
  f.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  return f.join(',');
}

/** Convert any audio buffer to WhatsApp voice-note format (ogg / opus, mono), with polishing. */
export async function toOggOpus(buf, { inputArgs = [], speed = 1, polish = true } = {}) {
  const inp = tmpFile(inputArgs.length ? 'pcm' : 'mp3'); const out = tmpFile('ogg');
  fs.writeFileSync(inp, buf);
  try {
    const args = ['-y', ...inputArgs, '-i', inp, '-vn', ...(polish ? ['-af', speechFilter(speed)] : []), '-c:a', 'libopus', '-b:a', '40k', '-ar', '48000', '-ac', '1', '-application', 'audio', out];
    try { await run('ffmpeg', args); }
    catch (e) { if (!polish) throw e; warn('voice polish failed, converting plainly:', e.message.slice(0, 100)); await run('ffmpeg', ['-y', ...inputArgs, '-i', inp, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', out]); }
    return fs.readFileSync(out);
  } finally { fs.rmSync(inp, { force: true }); fs.rmSync(out, { force: true }); }
}

/** Per-user voice options from stored prefs (/voice male|female, /speed 1.1). */
export function voiceOptsFor(userId, mood = '') {
  const p = (userId && mem.data.users[String(userId)]?.prefs) || {};
  return { mood, gender: p.voiceGender === 'male' ? 'male' : 'female', speed: Number(p.voiceSpeed) || 1 };
}

/** synthesize(text, langHint, { mood, gender, speed }) → { ogg:Buffer, lang, engine, mood } */
export async function synthesize(text, langHint = '', opts = {}) {
  const tagged = extractMood(text);
  let clean = speechExcerpt(cleanForSpeech(tagged.text));
  if (!clean) throw new Error('nothing to speak');
  const mood = opts.mood || tagged.mood || inferMood(clean);
  const o = { mood, gender: opts.gender === 'male' ? 'male' : 'female', speed: opts.speed || 1 };

  let lang = langHint && VOICE.ttsVoices[langHint] ? langHint : detectScript(clean);
  if (detectScript(clean) === 'en' && isRomanUrdu(clean)) {           // "kya haal hai" would be read with an English accent
    if (VOICE.transliterate) {
      const conv = await toNativeScript(clean, langHint === 'hi' ? 'hi' : 'ur');
      if (conv !== clean) { clean = conv; lang = detectScript(clean); }
      else lang = langHint === 'hi' ? 'hi' : 'ur';
    } else lang = langHint === 'hi' ? 'hi' : 'ur';
  } else if (detectScript(clean) === 'en' && langHint && langHint !== 'en') lang = 'en';

  const errs = [];
  for (const name of VOICE.ttsOrder) {
    const fn = ENGINES[name]; if (!fn) continue;
    try {
      const { buf, inputArgs } = await fn(clean, lang, o);
      const ogg = await toOggOpus(buf, { inputArgs, speed: o.speed });
      log(`TTS ok via ${name} (${lang}, mood ${mood}, ${clean.length} chars)`);
      return { ogg, lang, engine: name, mood };
    } catch (e) { errs.push(`${name}: ${e.message.slice(0, 90)}`); }
  }
  throw new Error('All TTS engines failed: ' + errs.join(' | '));
}
