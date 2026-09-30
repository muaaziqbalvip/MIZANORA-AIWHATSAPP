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

server.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nAll ${n} checks passed.`);
process.exit(0);
