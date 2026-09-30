// Network tools: live web search, safe page fetch, weather.
import dns from 'node:dns/promises';
import net from 'node:net';
import { env, keysFor, GEMINI_SEARCH_MODELS } from '../config.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── SSRF guard: never let the model fetch localhost / private network ────────────────
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

export async function assertPublicUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http/https URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Blocked host');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Blocked: private or unresolved address');
  return url;
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

export async function fetchUrl({ url, max_chars = 6000 }) {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(cur);
    const res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), u).toString(); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/text|json|xml/i.test(type)) throw new Error(`Unsupported content type: ${type}`);
    const raw = (await res.text()).slice(0, 800000);
    const body = /html/i.test(type) ? htmlToText(raw) : raw;
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim();
    return `${title ? `TITLE: ${title}\n` : ''}URL: ${u}\n\n${body.slice(0, Math.min(max_chars, 12000))}`;
  }
  throw new Error('Too many redirects');
}

// ── Web search: Tavily → Brave → Serper → DuckDuckGo (keyless fallback) ───────────────
const decodeDdg = (href) => {
  try {
    const m = href.match(/[?&]uddg=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : href.startsWith('//') ? 'https:' + href : href;
  } catch { return href; }
};

export function parseDuckDuckGo(html, max) {
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    out.push({ title: htmlToText(m[2]), url: decodeDdg(m[1]), snippet: htmlToText(m[3]) });
  }
  return out;
}

async function tavily(query, max) {
  const key = keysFor('tavily')[0]; if (!key) return null;
  const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ query, max_results: max, include_answer: true }), signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const j = await r.json();
  return { answer: j.answer || '', results: (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 400) })) };
}
async function brave(query, max) {
  const key = keysFor('brave')[0]; if (!key) return null;
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`brave ${r.status}`);
  const j = await r.json();
  return { results: (j.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: htmlToText(x.description || '') })) };
}
async function serper(query, max) {
  const key = keysFor('serper')[0]; if (!key) return null;
  const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, num: max }), signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`serper ${r.status}`);
  const j = await r.json();
  return { answer: j.answerBox?.answer || j.answerBox?.snippet || '', results: (j.organic || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '' })) };
}
async function duck(query, max) {
  const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`duckduckgo ${r.status}`);
  return { results: parseDuckDuckGo(await r.text(), max) };
}


// ── Gemini grounded search (google_search tool) — same as Mark-LIV's actions/web_search.py ──
const deadSearchModels = new Set(); // models that answered 404 (retired) — never retried this run
let groundingCooldownUntil = 0; // circuit breaker: grounding has its own small quota (Mark-LIV does the same)

export function parseGrounded(j) {
  const cand = j?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  const seen = new Set();
  const sources = [];
  for (const c of cand?.groundingMetadata?.groundingChunks || []) {
    const t = c.web?.title || '';
    if (t && !seen.has(t)) { seen.add(t); sources.push(t); }
  }
  return { text, sources };
}

async function geminiGrounded(query) {
  const keys = keysFor('gemini');
  if (!keys.length || Date.now() < groundingCooldownUntil) return null;
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    contents: [{ parts: [{ text: `Today is ${today}. Search the web and answer factually and concisely, with dates and numbers where relevant: ${query}` }] }],
    tools: [{ google_search: {} }],
  };
  let quota = 0; let tries = 0;
  for (const model of GEMINI_SEARCH_MODELS) {
    if (deadSearchModels.has(model)) continue;
    for (const key of keys) {
      tries++;
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
        });
        if (r.status === 429) { quota++; continue; }
        if (r.status === 404) deadSearchModels.add(model);
        if (!r.ok) break; // model problem (404/5xx) → next model on the ladder
        const { text, sources } = parseGrounded(await r.json());
        if (text) return { answer: text, sources, results: [] };
      } catch { break; }
    }
  }
  if (quota && quota >= tries) groundingCooldownUntil = Date.now() + 10 * 60000; // every rung out of quota → skip 10 min
  return null;
}

export async function webSearch({ query, max_results = 5 }) {
  const max = Math.min(Math.max(parseInt(max_results, 10) || 5, 1), 8);
  const errs = [];
  for (const fn of [geminiGrounded, tavily, brave, serper, duck]) {
    try {
      const r = await fn(query, max);
      if (r && r.sources && r.answer) {
        return `Live web answer (Google-grounded, ${new Date().toISOString().slice(0, 10)}):\n${r.answer}${r.sources.length ? `\n\nSources: ${r.sources.slice(0, 6).join(', ')}` : ''}`;
      }
      if (r && r.results.length) {
        const lines = r.results.slice(0, max).map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`);
        return `${r.answer ? `Quick answer: ${r.answer}\n\n` : ''}Search results for "${query}" (${new Date().toISOString().slice(0, 10)}):\n${lines.join('\n')}`;
      }
    } catch (e) { errs.push(e.message); }
  }
  return `No search results found${errs.length ? ` (${errs.join('; ')})` : ''}.`;
}

// ── Weather (Open-Meteo, no key) ─────────────────────────────────────────────────────
const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail' };

export async function getWeather({ city }) {
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, { signal: AbortSignal.timeout(15000) })).json();
  const loc = g.results?.[0];
  if (!loc) return `Could not find a place called "${city}".`;
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3`, { signal: AbortSignal.timeout(15000) })).json();
  const c = w.current;
  const days = w.daily.time.map((d, i) => `${d}: ${WMO[w.daily.weather_code[i]] || 'n/a'}, ${w.daily.temperature_2m_min[i]}–${w.daily.temperature_2m_max[i]}°C, rain chance ${w.daily.precipitation_probability_max[i]}%`);
  return `Weather in ${loc.name}, ${loc.country || ''}: now ${c.temperature_2m}°C (feels ${c.apparent_temperature}°C), ${WMO[c.weather_code] || 'n/a'}, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h.\nForecast:\n${days.join('\n')}`;
}

export { env };
