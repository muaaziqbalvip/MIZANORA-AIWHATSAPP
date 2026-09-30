// Offline self-test: no WhatsApp, no real API keys, no internet needed.
//   npm test
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-test-'));
let calls = { a: 0, b: 0 };

// ── mock provider A (always down) and B (works, does one tool round) ──

// ── mock of Meta's WhatsApp Agent Platform API (/agent/v1) ──
const agent = { queue: [], sent: [], uploads: [], statuses: [], mediaGets: [], offset: 100, badAuth: 0 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1500, 7)]);
function agentMock(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.headers.authorization !== 'Bearer test-key') { agent.badAuth++; return json(401, { error: { code: 190 } }); }
  const path = url.pathname.replace('/agent/v1', '');
  if (req.method === 'GET' && path === '/updates') {
    if (agent.queue.length) {
      const messages = agent.queue.splice(0);
      return json(200, { object: 'whatsapp_agent_platform', next_offset: ++agent.offset, entry: [{ changes: [{ field: 'messages', value: { messages, contacts: [{ wa_id: 'user:111', profile: { name: 'Muaaz' } }] } }] }] });
    }
    return void setTimeout(() => { res.writeHead(204); res.end(); }, 2000);
  }
  if (req.method === 'POST' && path === '/statuses') {
    const b = JSON.parse(body); agent.statuses.push(b);
    if (String(b.message_id).startsWith('wamid.X')) return json(403, { error: { code: 131005 } });
    return json(200, { success: true });
  }
  if (req.method === 'POST' && path === '/messages') { const b = JSON.parse(body); agent.sent.push(b); return json(200, { messages: [{ id: `wamid.OUT${agent.sent.length}` }] }); }
  if (req.method === 'POST' && path === '/media') { agent.uploads.push({ ct: req.headers['content-type'], hasProduct: body.includes('messaging_product'), len: body.length }); return json(200, { id: 'MEDIA1' }); }
  if (req.method === 'GET' && path === '/media/IMG1') { agent.mediaGets.push('meta'); return json(200, { id: 'IMG1', url: `http://127.0.0.1:${server.address().port}/agent/v1/media/IMG1/content`, mime_type: 'image/png', file_size: PNG.length }); }
  if (req.method === 'GET' && path === '/media/IMG1/content') { agent.mediaGets.push('bytes'); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
  json(404, { error: { code: 100 } });
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.startsWith('/agent/v1/')) return agentMock(req, res, body);
    const j = body ? JSON.parse(body) : {};
    if (req.url.startsWith('/a/')) { calls.a++; res.writeHead(500); return res.end('down'); }
    calls.b++;
    if (j.model === 'bad-model') { res.writeHead(429, { 'Retry-After': '1' }); return res.end('quota'); }
    const last = j.messages[j.messages.length - 1];
    const send = (message) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); };
    if (String(j.messages[0]?.content).includes('browser agent inside')) {
      const u = String(last.content);
      if (u.includes('SENSITIVE_TEST')) return send({ role: 'assistant', content: '{"thought":"buy it","action":{"type":"click","id":2}}' });
      const done = /RECENT ACTIONS:\n\d+\./.test(u);
      return send({ role: 'assistant', content: done ? '```json\n{"done":true,"answer":"Price is Rs 1999"}\n```' : '{"thought":"open product","action":{"type":"click","id":1}}' });
    }
    if (last.role === 'tool') return send({ role: 'assistant', content: `Done. Tool said: ${last.content}` });
    if (JSON.stringify(last.content).includes('my name is Muaaz') && j.tools) {
      return send({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'remember_fact', arguments: '{"fact":"Name is Muaaz"}' } }] });
    }
    send({ role: 'assistant', content: '<think>hidden</think>Salam! Main Mizanora hoon.' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

Object.assign(process.env, {
  MEMORY_DIR: path.join(tmp, 'mem'), WORKSPACE_DIR: path.join(tmp, 'ws'),
  LLM_PROVIDER_ORDER: 'ollama,custom',
  OLLAMA_URL: `http://127.0.0.1:${port}/a`, OLLAMA_MODEL: 'x',
  CUSTOM_BASE_URL: `http://127.0.0.1:${port}/b`, CUSTOM_API_KEYS: 'k1,k2', CUSTOM_MODEL: 'bad-model,m',
  OWNER_NUMBERS: '923001234567', STATE_PASSPHRASE: 'unit-test-passphrase-123',
  WHATSAPP_AGENT_API_KEY: 'test-key', WHATSAPP_AGENT_BASE_URL: `http://127.0.0.1:${port}/agent/v1`, AGENT_POLL_TIMEOUT: '1',
});

const { mem } = await import('../src/memory.js');
const { respond } = await import('../src/brain.js');
const { toolSpecs, executeTool } = await import('../src/tools/index.js');
const { parseDuckDuckGo, assertPublicUrl, parseGrounded } = await import('../src/tools/net.js');
const { chat } = await import('../src/llm.js');
const cfg = await import('../src/config.js');
const { detectScript, cleanForSpeech } = await import('../src/voice.js');
const { BOT } = await import('../src/config.js');

let n = 0; const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);
console.log('Mizanora self-test');

// identity
assert.equal(BOT.name, 'Mizanora'); assert.equal(BOT.developer, 'Muaaz Iqbal'); ok('identity: Mizanora by Muaaz Iqbal');

// router failover + tool loop + think-stripping + memory
mem.load();
const wa = { sendText: async () => {} };
const baseCtx = { chatId: '1@s.whatsapp.net', senderId: '923001234567@s.whatsapp.net', isGroup: false, isOwner: true, isGroupAdmin: false, wa, voiceSent: false };
let reply = await respond({ text: 'hi', senderName: 'Muaaz', ctx: { ...baseCtx } });
assert.equal(reply, 'Salam! Main Mizanora hoon.'); assert.ok(calls.a >= 1 && calls.b >= 1); ok('provider A down → failover to provider B; <think> stripped');
reply = await respond({ text: 'my name is Muaaz', senderName: 'Muaaz', ctx: { ...baseCtx } });
assert.match(reply, /Done\. Tool said: Saved\./); assert.ok(mem.user(baseCtx.senderId).facts.some((f) => f.text.includes('Muaaz'))); ok('tool-calling loop executes remember_fact and stores it');
assert.equal(mem.chat(baseCtx.chatId).history.length, 4); ok('history persisted (4 messages)');

const lr = await chat({ messages: [{ role: 'user', content: 'x' }] });
assert.equal(lr.model, 'm'); ok('model ladder: "bad-model" hits 429 on both keys → falls through to next model "m"');
assert.deepEqual(cfg.modelLadder(cfg.PROVIDERS.gemini.model).slice(0, 4), ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest']); assert.ok(cfg.modelLadder(cfg.PROVIDERS.gemini.model).includes('gemini-3.5-flash')); ok('Gemini ladder starts with the exact Mark-LIV ladder, then current 3.x fallbacks');
assert.deepEqual(cfg.GEMINI_SEARCH_MODELS.slice(0, 3), ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite']); ok('grounded-search ladder starts with Mark-LIV web_search ladder');
const g = parseGrounded({ candidates: [{ content: { parts: [{ text: 'Answer A' }] }, groundingMetadata: { groundingChunks: [{ web: { title: 'bbc.com' } }, { web: { title: 'bbc.com' } }, { web: { title: 'dawn.com' } }] } }] });
assert.equal(g.text, 'Answer A'); assert.deepEqual(g.sources, ['bbc.com', 'dawn.com']); ok('Gemini grounded-search response parser (answer + de-duplicated sources)');

// permissions
const guest = { ...baseCtx, isOwner: false };
assert.ok(!toolSpecs(guest).some((t) => t.function.name === 'run_python')); ok('non-owner does not even see run_python');
assert.match(await executeTool('run_shell', { command: 'echo hi' }, guest), /not permitted/); ok('non-owner cannot execute run_shell');
assert.ok(!toolSpecs(baseCtx).some((t) => t.function.name.startsWith('group_'))); ok('group tools hidden in private chats');
assert.ok(toolSpecs({ ...baseCtx, isGroup: true, isGroupAdmin: true, isOwner: false }).some((t) => t.function.name === 'group_add_members')); ok('group admins get group tools in groups');
const out = await executeTool('run_python', { code: 'import os,sys; print(6*7); print(os.environ.get("CUSTOM_API_KEYS"))' }, baseCtx);
assert.match(out, /42/); assert.match(out, /None/); ok('owner run_python works and API keys are NOT visible to child process');

// reminders
const r1 = await executeTool('set_reminder', { text: 'chai', in_minutes: 0.01 }, baseCtx); assert.match(r1, /Reminder/);
await new Promise((r) => setTimeout(r, 900)); assert.equal(mem.dueTasks().length, 1); ok('reminder scheduled and becomes due');

// SSRF
await assert.rejects(assertPublicUrl('http://127.0.0.1:8080/x'), /Blocked/); await assert.rejects(assertPublicUrl('http://localhost/'), /Blocked/);
await assert.rejects(assertPublicUrl('file:///etc/passwd'), /http/); ok('SSRF guard blocks localhost / private / file://');

// parsers / language
const html = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example &amp; Co</a> x <a class="result__snippet" href="#">A <b>nice</b> page</a>';
const parsed = parseDuckDuckGo(html, 5); assert.equal(parsed[0].url, 'https://example.com/a'); assert.equal(parsed[0].snippet, 'A nice page'); ok('DuckDuckGo result parser');
assert.equal(detectScript('آپ کیسے ہیں؟'), 'ur'); assert.equal(detectScript('आप कैसे हैं'), 'hi'); assert.equal(detectScript('how are you'), 'en'); ok('language/script detection (Urdu / Hindi / English)');
assert.equal(cleanForSpeech('**Salam** 😊 https://x.com ok'), 'Salam ok'); ok('speech text cleaner');

// persistence + encrypted state round-trip
mem.save();
const enc = path.join(tmp, 'state.enc');
execFileSync('node', [path.join(ROOT, 'scripts/state.js'), 'pack', enc], { env: process.env });
const before = fs.readFileSync(process.env.MEMORY_DIR + '/bot_memory.json', 'utf8');
fs.rmSync(process.env.MEMORY_DIR, { recursive: true });
execFileSync('node', [path.join(ROOT, 'scripts/state.js'), 'unpack', enc], { env: process.env });
assert.equal(fs.readFileSync(process.env.MEMORY_DIR + '/bot_memory.json', 'utf8'), before); ok('encrypted state pack → wipe → unpack restores memory exactly');
assert.throws(() => execFileSync('node', [path.join(ROOT, 'scripts/state.js'), 'unpack', enc], { env: { ...process.env, STATE_PASSPHRASE: 'wrong-passphrase-123' }, stdio: 'pipe' })); ok('wrong passphrase is rejected');



// ── WhatsApp Agent Platform transport (official API) against the mock ──
const { shortErr } = await import('../src/agentplatform.js');
assert.equal(shortErr(new Error('Speech-to-text failed: gemini: gemini-3.5-flash 503 {\n "error": {"code": 503}')), 'Speech-to-text failed: gemini: gemini-3.5-flash 503'); ok('user-facing errors never include raw JSON');
const { createAgentPlatform, parseUpdates: parseAgentUpdates, RateWindow, mediaUrlAllowed } = await import('../src/agentplatform.js');
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
let fatalCode = null;
const gw = await createAgentPlatform({ onFatal: (c) => { fatalCode = c; }, onOpen: () => {} });
assert.ok(gw.isOpen() && fatalCode === null); ok('agent platform: authenticated with Bearer key, long polling started');

const nowTs = () => String(Math.floor(Date.now() / 1000));
agent.queue.push({ id: 'wamid.T1', from: 'user:111', type: 'text', timestamp: nowTs(), text: { body: 'hi' } });
assert.ok(await waitFor(() => agent.sent.length >= 1), 'no reply was sent');
assert.equal(agent.sent[0].to, 'user:111'); assert.equal(agent.sent[0].type, 'text'); assert.equal(agent.sent[0].messaging_product, 'whatsapp'); assert.match(agent.sent[0].text.body, /Salam/);
ok('inbound text → AI → reply POSTed to /messages (to=user:111, messaging_product=whatsapp)');
assert.ok(agent.statuses.some((x) => x.status === 'read' && x.message_id === 'wamid.T1' && x.typing_indicator?.type === 'text')); ok('read receipt + typing indicator sent');
assert.equal(mem.data.meta.agentCreator, 'user:111'); assert.ok(Number.isInteger(mem.data.meta.agentOffset)); ok('creator confirmed via read receipt; poll offset persisted in memory');

const sentBefore = agent.sent.length;
agent.queue.push({ id: 'wamid.X1', from: 'user:999', type: 'text', timestamp: nowTs(), text: { body: 'hello from a stranger' } });
assert.ok(await waitFor(() => agent.statuses.some((x) => x.message_id === 'wamid.X1')));
await new Promise((r) => setTimeout(r, 2500));
assert.equal(agent.sent.length, sentBefore); ok('message from a non-creator (403/131005) is dropped without a reply');

agent.queue.push({ id: 'wamid.T2', from: 'user:111', type: 'image', timestamp: nowTs(), image: { id: 'IMG1', mime_type: 'image/png', sha256: 'x', caption: 'what is this?' } });
assert.ok(await waitFor(() => agent.sent.length >= sentBefore + 1)); assert.deepEqual(agent.mediaGets, ['meta', 'bytes']); ok('inbound image: GET /media/<id> then bytes downloaded with the key, reply sent');

agent.queue.push({ id: 'wamid.T1', from: 'user:111', type: 'text', timestamp: nowTs(), text: { body: 'duplicate id' } });
const n2 = agent.sent.length; await new Promise((r) => setTimeout(r, 2800)); assert.equal(agent.sent.length, n2); ok('duplicate message id is ignored (at-least-once delivery de-duplicated)');

await gw.wa.sendImage('user:111', PNG, 'cap');
assert.equal(agent.uploads.length, 1); assert.match(agent.uploads[0].ct, /multipart\/form-data/); assert.ok(agent.uploads[0].hasProduct);
const img = agent.sent[agent.sent.length - 1]; assert.equal(img.type, 'image'); assert.equal(img.image.id, 'MEDIA1'); assert.equal(img.image.caption, 'cap'); ok('image reply: multipart upload to /media then /messages type=image with the media id + caption');

await gw.wa.sendText('user:111', 'x'.repeat(9000));
const tail = agent.sent.slice(-3); assert.ok(tail.every((m) => m.text.body.length <= 4000) && tail.map((m) => m.text.body).join('').length === 9000); ok('long replies are split into <=4000-char messages');

const rw = new RateWindow(2); assert.ok(rw.tryAcquire() && rw.tryAcquire() && !rw.tryAcquire()); ok('rate window enforces the per-minute budget');
assert.equal(parseAgentUpdates({ object: 'whatsapp_agent_platform', next_offset: 5, entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'a' }] } }] }] }).messages.length, 1);
assert.throws(() => parseAgentUpdates({ object: 'nope' })); ok('updates envelope parser accepts the documented shape and rejects others');
assert.ok(!mediaUrlAllowed('https://evil.example.com/steal')); assert.ok(mediaUrlAllowed('https://lookaside.fbsbx.com/agent/v1/media/1/content')); ok('API key is only ever sent to Meta media hosts (evil host rejected)');
await gw.stop();

// ═════════════════════════ v2 upgrade checks ═════════════════════════
console.log('\nv2 upgrade');
const { extractMood, inferMood, moodParams } = await import('../src/emotion.js');
assert.deepEqual(extractMood('[mood: caring] Fikr na karein'), { text: 'Fikr na karein', mood: 'caring' });
assert.deepEqual(extractMood('[mood: bogus] hi'), { text: 'hi', mood: '' }); assert.equal(inferMood('Maazrat, ghalti ho gayi'), 'apology'); assert.ok(moodParams('excited').rate.startsWith('+'));
ok('voice emotion: mood tag parsed/stripped, unknown tags ignored, fallback inference, mood → rate/pitch');

const V = await import('../src/voice.js');
assert.ok(V.isRomanUrdu('kya haal hai aap ka') && V.isRomanUrdu('mujhe kal subah 8 baje uthana') && !V.isRomanUrdu('how are you doing today my friend'));
ok('Roman-Urdu detector (so it can be converted to Urdu script before speaking)');
assert.match(V.speechFilter(1.2), /atempo=1\.20/); assert.ok(V.speechFilter(1).includes('loudnorm') && !V.speechFilter(1).includes('atempo'));
assert.ok(V.speechExcerpt('Salam. '.repeat(400), 300).endsWith('.') && V.speechExcerpt('x'.repeat(50), 300).length === 50); ok('speech filter chain (silence trim + loudnorm + speed) and sentence-safe truncation');
try {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', '-ar', '24000', '-ac', '1', '-f', 's16le', path.join(tmp, 't.pcm')], { stdio: 'ignore' });
  const ogg = await V.toOggOpus(fs.readFileSync(path.join(tmp, 't.pcm')), { inputArgs: ['-f', 's16le', '-ar', '24000', '-ac', '1'], speed: 1.1 });
  assert.equal(ogg.subarray(0, 4).toString(), 'OggS'); ok('raw PCM (Gemini TTS format) → polished WhatsApp ogg/opus via ffmpeg');
} catch (e) { if (/ENOENT/.test(String(e.message))) console.log('  – skipped (ffmpeg missing)'); else throw e; }
const vo = (mem.user('vu1').prefs.voiceGender = 'male', mem.user('vu1').prefs.voiceSpeed = 1.2, V.voiceOptsFor('vu1', 'happy'));
assert.deepEqual(vo, { mood: 'happy', gender: 'male', speed: 1.2 }); ok('per-user voice style (gender/speed) feeds the synthesiser');

// search
const S = await import('../src/tools/search.js');
const items = S.parseRss('<rss><channel><item><title>Big news - Dawn</title><link>https://dawn.com/a?utm_source=x</link><pubDate>Wed, 30 Sep 2026 06:00:00 GMT</pubDate><source url="https://dawn.com">Dawn</source></item><item><title><![CDATA[Other &amp; story]]></title><link>https://bbc.com/b</link></item></channel></rss>');
assert.equal(items.length, 2); assert.equal(items[0].title, 'Big news'); assert.equal(items[0].source, 'Dawn'); assert.equal(items[1].title, 'Other & story'); assert.ok(items[0].published > 0); ok('news RSS parser (title/publisher/date, CDATA, entities)');
const mg = S.rrfMerge([{ engine: 'a', results: [{ title: 'X', url: 'https://www.example.com/p/?utm_source=z', snippet: 's' }, { title: 'Y', url: 'https://y.com/' }] }, { engine: 'b', results: [{ title: 'Y', url: 'https://y.com', snippet: 'longer snippet' }, { title: 'Z', url: 'https://z.com' }] }]);
assert.equal(mg.length, 3); assert.equal(mg[0].engines.length, 2); assert.equal(mg.find((r) => r.title === 'Y').snippet, 'longer snippet'); assert.ok(mg[2].engines.length === 1); ok('multi-engine merge: de-duplicates URLs (utm/www/slash), boosts results found by several engines');
const bh = S.parseBing('<li class="b_algo"><h2><a href="https://ex.org/a">Hello &amp; <strong>World</strong></a></h2><div class="b_caption"><p>Snippet <b>here</b></p></div></li>');
assert.deepEqual(bh[0], { title: 'Hello & World', url: 'https://ex.org/a', snippet: 'Snippet here' });
const b64 = Buffer.from('https://real.example/page').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
assert.equal(S.decodeBingUrl(`https://www.bing.com/ck/a?!&&p=1&u=a1${b64}&ntb=1`), 'https://real.example/page'); ok('Bing parser + redirect-link decoder');
const { mainText } = await import('../src/tools/net.js');
const mt = mainText('<nav>MENU</nav><article>' + 'Real content. '.repeat(50) + '</article><footer>legal</footer>'); assert.ok(mt.startsWith('Real content') && !mt.includes('MENU') && !mt.includes('legal')); ok('page reader strips nav/footer and keeps the article');

// scheduler
const SC = await import('../src/scheduler.js');
assert.equal(SC.TZ, 'Asia/Karachi');
const from = Date.parse('2026-09-30T02:00:00Z');                       // 07:00 in Karachi
assert.equal(new Date(SC.nextOccurrence({ type: 'daily', time: '08:00' }, from)).toISOString(), '2026-09-30T03:00:00.000Z');
assert.equal(new Date(SC.nextOccurrence({ type: 'daily', time: '06:00' }, from)).toISOString(), '2026-10-01T01:00:00.000Z');
assert.equal(new Date(SC.nextOccurrence({ type: 'weekly', days: [5], time: '21:30' }, from)).toISOString(), '2026-10-02T16:30:00.000Z');
assert.throws(() => SC.normalizeRepeat({ type: 'daily', time: '25:00' })); assert.throws(() => SC.normalizeRepeat({ type: 'every', minutes: 1 })); ok('recurring schedules computed in the bot timezone (daily / weekly / every N min) with validation');

const sent = []; const fakeWa = { sendText: async (to, t) => { sent.push(['text', to, t]); }, sendVoice: async (to, t) => { sent.push(['voice', to, t]); } };
const { startScheduler } = await import('../src/jobs.js');
const rem = mem.addTask({ chatId: 'c@1', dueAt: Date.now() - 10, text: 'chai', createdBy: 'x', repeat: { type: 'every', minutes: 5 } });
const job = mem.addTask({ chatId: 'c@1', dueAt: Date.now() - 10, text: 'daily brief', createdBy: 'x', kind: 'agent', repeat: { type: 'daily', time: '08:00' } });
const tm = startScheduler(() => fakeWa, { tickMs: 60 });
assert.ok(await waitFor(() => sent.length >= 2, 8000)); clearInterval(tm);
assert.ok(sent.some((x) => /Yaad dehani: chai/.test(x[2]))); assert.ok(sent.some((x) => /Salam! Main Mizanora/.test(x[2])));
const remAfter = mem.data.tasks.find((t) => t.id === rem.id); const jobAfter = mem.data.tasks.find((t) => t.id === job.id);
assert.ok(!remAfter.done && remAfter.dueAt > Date.now() + 4 * 60000 && remAfter.runs === 1); assert.ok(!jobAfter.done && jobAfter.dueAt > Date.now() && jobAfter.runs === 1);
ok('automation: recurring reminder + recurring AI agent job both fire, deliver to the chat and reschedule themselves');

// tools & permissions
const ownerNames = toolSpecs(baseCtx).map((t) => t.function.name); const guestNames = toolSpecs(guest).map((t) => t.function.name);
for (const n of ['browse', 'browser_task', 'screenshot', 'schedule_task', 'write_file', 'zip_and_send']) { assert.ok(ownerNames.includes(n), `owner missing ${n}`); assert.ok(!guestNames.includes(n), `guest sees ${n}`); }
for (const n of ['web_search', 'news_search', 'deep_research', 'wikipedia', 'currency_convert', 'crypto_price', 'set_voice_style', 'set_reminder']) assert.ok(guestNames.includes(n), `everyone should have ${n}`);
ok('new tools registered: browser/automation/files owner-only; search, news, research, finance, voice-style for everyone');
assert.match(await executeTool('schedule_task', { prompt: 'x', in_minutes: 5 }, guest), /not permitted/); assert.match(await executeTool('browser_task', { goal: 'x' }, guest), /not permitted/); ok('non-owner cannot schedule agent jobs or drive the browser');
const st = await executeTool('schedule_task', { prompt: 'weather + news', repeat: { type: 'daily', time: '08:00' }, voice: true }, baseCtx); assert.match(st, /Scheduled task \w+/); assert.match(await executeTool('list_reminders', {}, baseCtx), /🤖 task/); ok('schedule_task tool creates a daily voice job that shows up in list_reminders');
assert.match(await executeTool('write_file', { filename: '../evil.txt', content: 'x' }, baseCtx), /escapes/); assert.match(await executeTool('write_file', { filename: 'ok/a.txt', content: 'hi' }, baseCtx), /Wrote/); assert.equal(await executeTool('read_file', { filename: 'ok/a.txt' }, baseCtx), 'hi'); ok('workspace file tools work and cannot escape the workspace');

// browser agent (fake Playwright page — no Chromium needed)
const B = await import('../src/tools/browser.js');
const clicks = []; const typed = [];
const snapEls = [{ id: 1, tag: 'a', type: '', label: 'Samsung A15 128GB', href: '/p/1', value: '' }, { id: 2, tag: 'button', type: '', label: 'Buy now', href: '', value: '' }, { id: 3, tag: 'input', type: 'password', label: 'Password', href: '', value: '' }, { id: 4, tag: 'input', type: 'text', label: 'Search', href: '', value: '' }];
const fakePage = {
  url: () => 'https://shop.example/cart', title: async () => 'Shop',
  evaluate: async () => ({ title: 'Shop', url: 'https://shop.example/cart', text: 'Samsung A15 — Rs 1999', elements: snapEls, y: 0, h: 2000, vh: 800 }),
  locator: (sel) => ({ first: () => ({ click: async () => clicks.push(sel), fill: async (t) => typed.push([sel, t]) }) }),
  waitForLoadState: async () => {}, waitForTimeout: async () => {}, keyboard: { press: async () => {} }, mouse: { wheel: async () => {} },
};
const bs = new B.BrowserSession({}, {}); bs.page = fakePage;
await bs.snapshot();
await assert.rejects(bs.act({ type: 'click', id: 2 }), (e) => e instanceof B.NeedConfirm);
assert.equal(clicks.length, 0); await bs.act({ type: 'click', id: 2 }, { allowSensitive: true }); assert.equal(clicks.length, 1);
await assert.rejects(bs.act({ type: 'type', id: 3, text: 'hunter2' }), (e) => e instanceof B.Blocked);
await assert.rejects(bs.act({ type: 'type', id: 4, text: '4111 1111 1111 1111' }), (e) => e instanceof B.Blocked);
await bs.act({ type: 'type', id: 4, text: 'samsung a15', submit: true }); assert.deepEqual(typed[0], ['[data-mz="4"]', 'samsung a15']);
ok('browser safety: buy/pay clicks need confirmation; passwords and card numbers are never typed; normal typing works');
clicks.length = 0;
const br1 = await B.runBrowserTask({ goal: 'find the price of Samsung A15', maxSteps: 5, session: bs });
assert.equal(br1.status, 'done'); assert.match(br1.text, /1999/); assert.equal(clicks.length, 1); ok('browser agent loop: LLM picks an action → page acts → LLM finishes with the answer (fenced JSON tolerated)');
const br2 = await B.runBrowserTask({ goal: 'SENSITIVE_TEST order it', maxSteps: 4, session: bs });
assert.equal(br2.status, 'confirm'); assert.match(br2.text, /Buy now/); ok('browser agent stops and asks the user before a purchase-type click');
const blocked = []; const route = (u) => ({ request: () => ({ url: () => u }), abort: async () => blocked.push(u), continue: async () => blocked.push('ok:' + u) });
await bs.guard(route('http://127.0.0.1:8080/admin')); await bs.guard(route('http://169.254.169.254/latest/meta-data')); await bs.guard(route('file:///etc/passwd'));
assert.deepEqual(blocked, ['http://127.0.0.1:8080/admin', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']); ok('browser network guard aborts requests to localhost / cloud-metadata / file://');
assert.equal(B.normalizeUrl('instagram'), 'https://instagram.com'); assert.match(B.normalizeUrl('best laptops 2026'), /bing\.com\/search\?q=best%20laptops%202026/); ok('smart URL normaliser (bare site name, domain, free text → search)');

// commands
const { handleCommand } = await import('../src/commands.js');
const cc = { senderId: 'cmd1', chatId: 'cmdchat', isOwner: true, wa: fakeWa, msgKey: null };
assert.match(await handleCommand('voice', 'male', cc), /mard/); assert.equal(mem.user('cmd1').prefs.voiceGender, 'male');
assert.match(await handleCommand('speed', '1.2', cc), /1\.2/); assert.equal(mem.user('cmd1').prefs.voiceSpeed, 1.2); assert.match(await handleCommand('speed', '9', cc), /0\.7/);
assert.match((await handleCommand('research', 'ev cars in pakistan', cc)).rewrite, /deep_research/); assert.match(await handleCommand('browse', 'x.com', { ...cc, isOwner: false }), /owner/);
assert.match(await handleCommand('help', '', cc), /\/research/); assert.equal(await handleCommand('nonsense', '', cc), null); ok('slash commands: /voice male, /speed, /research, /browse (owner-only), /help, unknown → passes to AI');

// full pipeline: mood-tagged voice reply is stripped for text and exposed for the voice engine
const mctx = { ...baseCtx, chatId: 'mood@1', senderId: 'mood@1' };
const moodReply = await respond({ text: 'hi', voiceReply: true, ctx: mctx }); assert.ok(!/\[mood/.test(moodReply)); assert.ok(['neutral', 'happy', 'excited', 'calm', 'serious', 'caring', 'sad', 'apology'].includes(mctx.replyMood)); ok('brain: reply mood resolved for the voice engine, tag never leaks into text');

server.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nAll ${n} checks passed.`);
process.exit(0);
