// Firebase (Admin SDK) access for the cloud-run agents. All secrets come from GitHub Actions secrets.
import admin from 'firebase-admin';
let db = null;
export const cloud = () => { if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null; if (!db) { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); db = admin.firestore(); } return db; };
export const FV = () => admin.firestore.FieldValue;
export function startBeat(uid, channel) { const d = cloud(); if (!d || !uid) return; const f = async () => { try { const r = d.doc(`users/${uid}`), s = (await r.get()).data() || {}; if (s.status !== 'approved' || s.ctl === 'stop') { console.log('Stopped by owner/admin control'); process.kill(process.pid, 'SIGTERM'); return; } await r.set({ beat: { [channel]: Date.now() } }, { merge: true }); } catch {} }; f(); setInterval(f, 60000).unref?.(); }

// ── Durable memory: gzip(memory.json) in Firestore doc memory/<uid>-<channel> so restarts/new shifts never forget.
import zlib from 'node:zlib';
import fs from 'node:fs';
import { PATHS } from './config.js';
const mkey = () => `${process.env.AGENT_UID}-${process.env.CHANNEL || 'whatsapp'}`;
const enabled = () => !!(cloud() && process.env.AGENT_UID);
export async function restoreMemory() {
  if (!enabled()) return false;
  try {
    const s = (await cloud().doc(`memory/${mkey()}`).get()).data();
    if (!s?.gz) return false;
    const local = fs.existsSync(PATHS.memoryFile) ? fs.statSync(PATHS.memoryFile).mtimeMs : 0;
    if (local && local >= s.at) return false;
    fs.writeFileSync(PATHS.memoryFile, zlib.gunzipSync(Buffer.from(s.gz, 'base64')));
    console.log('Memory restored from Firestore');
    return true;
  } catch (e) { console.warn('cloud memory restore failed:', e.message.slice(0, 80)); return false; }
}
export async function pushMemory(data) {
  if (!enabled()) return;
  try {
    let d = data, gz = zlib.gzipSync(JSON.stringify(d)).toString('base64');
    for (let i = 0; gz.length > 900000 && i < 6; i++) { // Firestore doc limit ~1MB: drop oldest history first
      d = { ...d, chats: Object.fromEntries(Object.entries(d.chats || {}).map(([k, c]) => [k, { ...c, history: (c.history || []).slice(-Math.max(4, 20 - i * 3)) }])) };
      gz = zlib.gzipSync(JSON.stringify(d)).toString('base64');
    }
    await cloud().doc(`memory/${mkey()}`).set({ gz, at: Date.now(), bytes: gz.length });
  } catch (e) { console.warn('cloud memory push failed:', e.message.slice(0, 80)); }
}
// Per-user activity log for the dashboard (capped).
export async function logActivity(uid, kind, text) {
  const d = cloud(); if (!d || !uid) return;
  d.collection('activity').add({ uid, kind, text: String(text).slice(0, 200), at: Date.now() }).catch(() => {});
}
