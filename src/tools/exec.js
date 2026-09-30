// Code execution. Only the bot OWNER can reach these (enforced in tools/index.js).
// Child processes get a minimal environment — API keys and secrets are NOT passed down.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PATHS } from '../config.js';

const cleanEnv = () => ({
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  HOME: PATHS.workspace,
  LANG: process.env.LANG || 'C.UTF-8',
  PYTHONIOENCODING: 'utf-8',
  PYTHONUNBUFFERED: '1',
});

function exec(cmd, args, { timeoutMs = 60000, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(cmd, args, { cwd: PATHS.workspace, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let killed = false;
    const add = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-100000); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const to = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(to); resolve(`Failed to start ${cmd}: ${e.message}`); });
    p.on('close', (code) => {
      clearTimeout(to);
      const body = out.length > 4000 ? out.slice(0, 1800) + '\n…[truncated]…\n' + out.slice(-1800) : out;
      resolve(`${killed ? '[killed: timeout] ' : ''}exit=${code} time=${((Date.now() - started) / 1000).toFixed(1)}s\n${body || '(no output)'}`);
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

export async function runPython({ code, timeout_sec = 60 }) {
  const file = path.join(PATHS.workspace, `run_${Date.now()}.py`);
  fs.writeFileSync(file, String(code));
  try { return await exec('python3', [file], { timeoutMs: Math.min(Math.max(timeout_sec, 5), 170) * 1000 }); }
  finally { fs.rmSync(file, { force: true }); }
}

export async function runShell({ command, timeout_sec = 60 }) {
  return exec('bash', ['-c', String(command)], { timeoutMs: Math.min(Math.max(timeout_sec, 5), 170) * 1000 });
}

export function listWorkspace() {
  return fs.readdirSync(PATHS.workspace).slice(0, 100).map((f) => {
    const s = fs.statSync(path.join(PATHS.workspace, f));
    return `${s.isDirectory() ? 'd' : '-'} ${f} (${s.size} bytes)`;
  }).join('\n') || '(workspace is empty)';
}
