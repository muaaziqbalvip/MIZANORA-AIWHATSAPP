// Prints KEY=VALUE lines (for $GITHUB_ENV) from the user's saved dashboard config in Firestore.
import { cloud } from '../src/cloud.js';
const s = await cloud().doc(`users/${process.argv[2]}`).get(); const d = s.data() || {};
if (d.status !== 'approved') { console.error('user not approved'); process.exit(1); }
for (const [k, v] of Object.entries(d.cfg || {})) if (/^[A-Z_]+$/.test(k) && v && !/[\r\n]/.test(v)) console.log(`${k}=${v}`);
console.log(`NEWS_ENABLED=${d.news ? 'true' : 'false'}`);
