// Firebase (Admin SDK) access for the cloud-run agents. All secrets come from GitHub Actions secrets.
import admin from 'firebase-admin';
let db = null;
export const cloud = () => { if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null; if (!db) { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); db = admin.firestore(); } return db; };
export const FV = () => admin.firestore.FieldValue;
export function startBeat(uid, channel) { const d = cloud(); if (!d || !uid) return; const f = () => d.doc(`users/${uid}`).set({ beat: { [channel]: Date.now() } }, { merge: true }).catch(() => {}); f(); setInterval(f, 60000).unref?.(); }
