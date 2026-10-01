// Runs in the "plan" job: prints the matrix of agents to start (GITHUB_OUTPUT). Needs FIREBASE_SERVICE_ACCOUNT.
import fs from 'node:fs';
import { cloud } from '../src/cloud.js';
import { plan } from '../src/plan.js';
const out = (k, v) => { const l = `${k}=${v}\n`; process.env.GITHUB_OUTPUT ? fs.appendFileSync(process.env.GITHUB_OUTPUT, l) : process.stdout.write(l); };
try {
  const db = cloud(); if (!db) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
  const conf = (await db.doc('pub/settings').get()).data() || {};
  const users = (await db.collection('users').where('status', '==', 'approved').get()).docs.map((d) => ({ uid: d.id, ...d.data() }));
  const bizMap = {}; await Promise.all(users.filter((u) => (u.channels || []).includes('business')).map(async (u) => { bizMap[u.uid] = (await db.doc(`biz/${u.uid}`).get()).data(); }));
  const { include, report } = plan(users, bizMap, conf), m = { include };
  for (const u of users) { console.error(` - ${u.uid} (${u.email || '?'}): ${report[u.uid]}`); await db.doc(`users/${u.uid}`).set({ plan: { msg: report[u.uid] || '', at: Date.now() } }, { merge: true }).catch(() => {}); }
  console.error(`plan: ${users.length} approved users → ${m.include.length} agents${conf.paused ? ' (PAUSED by admin)' : ''}`);
  out('agents', JSON.stringify(m.include.length ? m.include.map((x) => `${x.uid}:${x.ch}`) : ['none'])); out('any', String(m.include.length > 0));
} catch (e) { console.error('plan failed:', e.message); out('agents', '["none"]'); out('any', 'false'); }
