// Shared helpers: turn received documents into text for the AI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function pdfToText(buf) {
  return new Promise((resolve) => {
    const f = path.join(os.tmpdir(), `mz-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.pdf`);
    fs.writeFileSync(f, buf);
    const p = spawn('pdftotext', ['-layout', f, '-']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { fs.rmSync(f, { force: true }); resolve(''); });
    p.on('close', () => { fs.rmSync(f, { force: true }); resolve(out); });
  });
}

const TEXT_EXT = /\.(txt|md|csv|json|py|js|ts|html|css|log|xml|yml|yaml|ini|sh)$/i;

/** → text content of a document, or '' if it cannot be read as text. */
export async function extractDocText(buf, name = '', mime = '') {
  if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) return pdfToText(buf);
  if (/^text\//i.test(mime) || /json|xml|csv|javascript/i.test(mime) || TEXT_EXT.test(name)) return buf.toString('utf8');
  return '';
}

export function docMimeFromName(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (n.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return 'text/plain'; // txt, md, csv, json, code… — sent as plain text documents
}
