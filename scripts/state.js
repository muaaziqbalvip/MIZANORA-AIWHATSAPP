#!/usr/bin/env node
// Encrypt / decrypt the whole memory_store/ folder (chat memory + WhatsApp session keys).
//   STATE_PASSPHRASE=... node scripts/state.js pack   <out.enc>
//   STATE_PASSPHRASE=... node scripts/state.js unpack <in.enc>
// Format: "MZN1" | salt(16) | iv(12) | authTag(16) | AES-256-GCM ciphertext of a .tar.gz
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(ROOT, process.env.MEMORY_DIR || 'memory_store');
const MAGIC = Buffer.from('MZN1');

const pass = process.env.STATE_PASSPHRASE;
const [cmd, file] = process.argv.slice(2);
if (!pass || pass.length < 12) { console.error('STATE_PASSPHRASE must be set (min 12 chars).'); process.exit(2); }
if (!['pack', 'unpack'].includes(cmd) || !file) { console.error('usage: state.js pack|unpack <file>'); process.exit(2); }

const deriveKey = (salt) => crypto.scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

if (cmd === 'pack') {
  if (!fs.existsSync(DIR)) { console.error(`Nothing to pack: ${DIR} missing`); process.exit(1); }
  const tmp = path.join(os.tmpdir(), `mz-state-${process.pid}.tgz`);
  // snapshot copy first so we never tar a half-written file
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-snap-'));
  fs.cpSync(DIR, snap, { recursive: true, filter: (s) => !s.endsWith('.tmp') });
  execFileSync('tar', ['czf', tmp, '-C', snap, '.']);
  const plain = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true }); fs.rmSync(snap, { recursive: true, force: true });
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  fs.writeFileSync(file, Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]));
  console.log(`packed ${plain.length} bytes → ${file} (${fs.statSync(file).size} bytes encrypted)`);
} else {
  const blob = fs.readFileSync(file);
  if (!blob.subarray(0, 4).equals(MAGIC)) { console.error('Not a Mizanora state file.'); process.exit(1); }
  const salt = blob.subarray(4, 20); const iv = blob.subarray(20, 32); const tag = blob.subarray(32, 48); const ct = blob.subarray(48);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
  d.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([d.update(ct), d.final()]); }
  catch { console.error('Decryption failed — wrong STATE_PASSPHRASE or corrupted file.'); process.exit(1); }
  const tmp = path.join(os.tmpdir(), `mz-state-${process.pid}.tgz`);
  fs.writeFileSync(tmp, plain);
  fs.mkdirSync(DIR, { recursive: true });
  execFileSync('tar', ['xzf', tmp, '-C', DIR]);
  fs.rmSync(tmp, { force: true });
  console.log(`restored state into ${DIR}`);
}
