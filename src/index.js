// Mizanora — main entry point. Developed by Muaaz Iqbal.
import { BOT, RUNTIME, ACCESS, WA_MODE } from './config.js';
import { mem } from './memory.js';
import { enabledProviders } from './config.js';
import { createWhatsApp } from './whatsapp.js';
import { createAgentPlatform } from './agentplatform.js';
import { log, warn, err } from './log.js';

const pairMode = process.argv.includes('--pair') && WA_MODE === 'baileys';
let gateway = null;
let waApi = null;
let schedTimer = null;
let shuttingDown = false;

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Graceful shutdown (${reason}) — saving state…`);
  try {
    clearInterval(schedTimer);
    mem.data.meta.lastShutdown = { at: new Date().toISOString(), reason };
    mem.logEvent(`shutdown: ${reason}`);
    mem.stopAutosave();
    mem.save();
    await Promise.race([gateway?.stop?.(), new Promise((r) => setTimeout(r, 5000))]);
  } catch (e) { warn('shutdown error:', e.message); }
  mem.save(); // final write after WhatsApp creds have been flushed
  log(`State saved. Exit code ${code}.`);
  process.exit(code);
}

function startScheduler() {
  schedTimer = setInterval(async () => {
    if (!waApi) return;
    for (const t of mem.dueTasks()) {
      try {
        await waApi.sendText(t.chatId, `⏰ Yaad dehani: ${t.text}`);
        mem.finishTask(t.id);
      } catch (e) { warn(`reminder ${t.id} failed:`, e.message); }
    }
  }, 20000);
}

async function main() {
  console.log(`\n[SYSTEM ONLINE] ${BOT.name} initialized with persistent memory. — by ${BOT.developer}\n`);

  mem.load();
  mem.startAutosave(RUNTIME.saveEverySec);

  const providers = enabledProviders();
  log(`LLM providers ready: ${providers.length ? providers.join(' → ') : 'NONE (add API keys!)'}`);
  log(`WhatsApp transport: ${WA_MODE === 'agent' ? 'official WhatsApp Agent Platform API (no pairing needed)' : 'Baileys / WhatsApp Web (unofficial)'}`);
  if (WA_MODE === 'baileys' && !ACCESS.owners.length) warn('OWNER_NUMBERS is empty — nobody can use owner-only tools (code execution, admin).');

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => { err('uncaughtException:', e.stack || e.message); mem.logEvent(`uncaught: ${e.message}`); });
  process.on('unhandledRejection', (e) => { err('unhandledRejection:', e?.stack || e); mem.logEvent(`rejection: ${e?.message || e}`); });

  if (RUNTIME.maxRuntimeMin > 0) {
    const ms = RUNTIME.maxRuntimeMin * 60000;
    log(`Runtime limit: ${RUNTIME.maxRuntimeMin} min — will save state and exit cleanly, then the next runner takes over.`);
    setTimeout(() => shutdown('runtime-limit reached', 0), ms).unref?.();
  }

  if (pairMode) {
    log('PAIR MODE — waiting up to 12 minutes for you to enter the pairing code on your phone.');
    setTimeout(() => { if (!gateway?.isOpen?.()) shutdown('pairing timed out (no link within 12 min)', 1); }, 12 * 60000).unref?.();
  }

  const create = WA_MODE === 'agent' ? createAgentPlatform : createWhatsApp;
  gateway = await create({
    pairMode,
    onFatal: (code) => shutdown(code === 0 ? 'pairing done' : `fatal(${code})`, code),
    onOpen: (wa) => { waApi = wa; },
  });
  startScheduler();
}

main().catch((e) => { err('Fatal startup error:', e.stack || e.message); shutdown('startup error', 1); });
