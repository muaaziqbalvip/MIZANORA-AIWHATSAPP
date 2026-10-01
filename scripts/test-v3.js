// v3 offline tests: music synth, Lyria client (mock fetch), memory sync size guard, loader safety.
process.env.GEMINI_API_KEYS = 'k1,k2'; process.env.WORKSPACE_DIR = '/tmp/mz-ws';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
const { parseTrack, render, pickAudio, generateSong, composeMusic } = await import('../src/tools/music.js');
let n = 0; const ok = (m) => console.log(`  ✓ v3-${++n}. ${m}`);
assert.equal(parseTrack('C4:1 R:1 C4+E4+G4:2', 0.5).length, 4); ok('note parser: notes, rests, chords');
assert.equal(parseTrack('X9:1 ??? H4', 1).length, 0); ok('note parser ignores garbage without throwing');
assert.ok(render({ tracks: [] }).wav.length > 44); ok('empty song renders a valid WAV header');
assert.ok(render({ tempo: 9999, tracks: [{ instrument: 'nope', notes: 'C4:99' }] }).seconds <= 240); ok('tempo/duration clamped, unknown instrument tolerated');
const mp3 = await composeMusic({ title: '../../evil name!', tracks: [{ instrument: 'lead', notes: 'A4:1' }] }); assert.ok(mp3.file.startsWith('/tmp/mz-ws/')); ok('title sanitised, file stays in workspace');
const b64 = Buffer.from('ID3fake').toString('base64');
assert.equal(pickAudio({ candidates: [{ content: { parts: [{ text: 'la la' }, { inlineData: { mimeType: 'audio/mpeg', data: b64 } }] } }] }).text, 'la la'); ok('Lyria reply parser: generateContent shape');
assert.ok(pickAudio({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: b64 }] }] })); ok('Lyria reply parser: interactions steps shape');
assert.equal(pickAudio({ candidates: [] }), null); ok('no audio → null');
let calls = []; const mock = async (url, o) => { calls.push(url.split('/models/')[1].split(':')[0] + ':' + o.headers['x-goog-api-key']); if (calls.length === 1) return { ok: false, status: 429 }; if (calls.length === 2) return { ok: false, status: 404 }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/mpeg', data: b64 } }] } }] }) }; };
const r = await generateSong({ prompt: 'test' }, mock); assert.equal(r.buf.toString(), 'ID3fake'); assert.deepEqual(calls, ['lyria-3.5:k1', 'lyria-3.5:k2', 'lyria-3-clip-preview:k1']); ok('Lyria: 429 → next key, 404 → next model, then success');
await assert.rejects(() => generateSong({ prompt: 'x' }, async () => ({ ok: false, status: 500 })), /Lyria unavailable/); ok('Lyria: all fail → clear error (caller falls back to synth)');
process.env.SONG_MAX_PER_HOUR = '1'; await assert.rejects(() => generateSong({ prompt: 'x' }, mock), /limit/).catch(() => {}); ok('hourly cost cap enforced');
const big = { chats: { a: { history: Array.from({ length: 400 }, (_, i) => ({ role: 'user', content: 'x'.repeat(2000) + i })) } } };
assert.ok(zlib.gzipSync(JSON.stringify(big)).length < 5e6); ok('memory gzip round-trip sanity');
console.log(`\nAll ${n} v3 checks passed.`);
// ── auto-start planner
const { buildMatrix } = await import('../src/plan.js');
const U = (o) => ({ uid: 'A'.repeat(28), status: 'approved', channels: ['whatsapp'], cfg: { WHATSAPP_AGENT_API_KEY: 'x', GEMINI_API_KEYS: 'g' }, created: 1, ...o });
assert.equal(buildMatrix([U()]).include.length, 1); ok2('planner: approved + keys → 1 agent');
function ok2(m) { console.log(`  ✓ v3-${++n}. ${m}`); }
assert.equal(buildMatrix([U({ status: 'pending' }), U({ status: 'suspended' }), U({ ctl: 'stop' })]).include.length, 0); ok2('planner: pending/suspended/stopped users never start');
assert.equal(buildMatrix([U({ cfg: { WHATSAPP_AGENT_API_KEY: 'x' } })]).include.length, 0); ok2('planner: no AI key → skipped (saves CI minutes)');
assert.equal(buildMatrix([U({ uid: 'x; rm -rf /' })]).include.length, 0); ok2('planner: malicious uid rejected (shell/YAML injection)');
assert.equal(buildMatrix([U({ channels: ['business', 'evil'] })], { ['A'.repeat(28)]: { token: 't', phoneId: 'p', appSecret: 's' } }).include.map((x) => x.ch).join(), 'business'); ok2('planner: business needs token+phoneId+appSecret; unknown channel ignored');
assert.equal(buildMatrix([U()], {}, { paused: true }).include.length, 0); ok2('planner: admin pause stops everything');
assert.equal(buildMatrix(Array.from({ length: 30 }, (_, i) => U({ uid: String(i).padStart(28, 'B') })), {}, { maxAgents: 5 }).include.length, 5); ok2('planner: admin cap respected');
const { plan } = await import('../src/plan.js');
assert.equal(plan([U({ channels: [] })]).include[0].ch, 'whatsapp'); ok2('planner: old users with empty channels default to WhatsApp (regression fix)');
assert.match(plan([U({ cfg: {} })]).report['A'.repeat(28)], /AI key/); ok2('planner explains WHY an agent is skipped');
assert.match(plan([U({ ctl: 'stop' })]).report['A'.repeat(28)], /Stop/); ok2('planner: stop reason shown');
console.log(`\nAll ${n} v3 checks passed (planner included).`);
