// Prints KEY=VALUE lines (for $GITHUB_ENV) from the user's saved dashboard config in Firestore.
import { cloud } from '../src/cloud.js';
const s = await cloud().doc(`users/${process.argv[2]}`).get(); const d = s.data() || {};
if (d.status !== 'approved') { console.error('user not approved'); process.exit(1); }
if (d.ctl === 'stop') { console.error('stopped by user'); process.exit(1); }
const BAD = /^(NODE|PATH|LD_|GITHUB_|RUNNER_|ACTIONS_|INPUT_|NPM_|PYTHON|PLAYWRIGHT|BASH|SHELL|HOME|FIREBASE|AGENT_UID|CHANNEL|MEMORY_DIR|MAX_RUNTIME|BROWSER_ENABLED|WORKSPACE|STATE_|ALLOW|HTTPS?_PROXY|SSL_|CURL_)/;
for (const [k, v] of Object.entries(d.cfg || {})) if (/^[A-Z_]+$/.test(k) && !BAD.test(k) && v && !/[\r\n]/.test(v)) console.log(`${k}=${v}`);
console.log(`NEWS_ENABLED=${d.news ? 'true' : 'false'}`);
