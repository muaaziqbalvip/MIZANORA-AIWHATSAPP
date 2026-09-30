// Text-to-image with automatic provider fallback: Pollinations → HuggingFace FLUX → Together FLUX → OpenAI.
import { IMAGE_ORDER, env, keysFor } from '../config.js';
import { log, warn } from '../log.js';

const isImage = (buf) => buf.length > 1000 && (
  (buf[0] === 0xff && buf[1] === 0xd8) ||                                  // JPEG
  (buf[0] === 0x89 && buf[1] === 0x50) ||                                  // PNG
  (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP')
);

async function pollinations(prompt, size) {
  const key = keysFor('pollinations')[0];
  const seed = Math.floor(Math.random() * 1e6);
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${env('POLLINATIONS_IMAGE_MODEL', 'flux')}&width=${size}&height=${size}&seed=${seed}&nologo=true${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  const r = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`pollinations ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function huggingface(prompt) {
  const key = env('HF_TOKEN') || keysFor('huggingface')[0];
  if (!key) return null;
  const model = env('HF_IMAGE_MODEL', 'black-forest-labs/FLUX.1-schnell');
  const r = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'image/png' },
    body: JSON.stringify({ inputs: prompt }), signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`huggingface ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function together(prompt, size) {
  const key = keysFor('together')[0]; if (!key) return null;
  const r = await fetch('https://api.together.xyz/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env('TOGETHER_IMAGE_MODEL', 'black-forest-labs/FLUX.1-schnell'), prompt, width: size, height: size, steps: 4, n: 1, response_format: 'base64' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`together ${r.status}`);
  const j = await r.json();
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('together: no image');
  return Buffer.from(b64, 'base64');
}

async function openaiImage(prompt) {
  const key = keysFor('openai')[0]; if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env('OPENAI_IMAGE_MODEL', 'gpt-image-1'), prompt, size: '1024x1024', n: 1 }),
    signal: AbortSignal.timeout(150000),
  });
  if (!r.ok) throw new Error(`openai image ${r.status}`);
  const j = await r.json();
  const d = j.data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
  if (d?.url) return Buffer.from(await (await fetch(d.url)).arrayBuffer());
  throw new Error('openai: no image');
}

export async function generateImageBuffer(prompt, size = 1024) {
  const errs = [];
  for (const prov of IMAGE_ORDER) {
    try {
      let buf = null;
      if (prov === 'pollinations') buf = await pollinations(prompt, size);
      else if (prov === 'huggingface') buf = await huggingface(prompt);
      else if (prov === 'together') buf = await together(prompt, size);
      else if (prov === 'openai') buf = await openaiImage(prompt);
      if (buf && isImage(buf)) { log(`image generated via ${prov} (${buf.length} bytes)`); return buf; }
      if (buf) errs.push(`${prov}: response was not an image`);
    } catch (e) { errs.push(e.message); warn('image provider failed:', e.message); }
  }
  throw new Error('Image generation failed on all providers: ' + (errs.join(' | ') || 'none configured'));
}
