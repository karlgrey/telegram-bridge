import { existsSync, readFileSync } from 'node:fs';
import { createBot } from './bot.js';
import { startNotifyServer } from './notify.js';
import { startHeartbeat } from './status.js';
import { log, logError } from './log.js';
import { PollWatchdog } from './watchdog.js';

// .env laden (ohne Dependency)
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN fehlt (.env)');
if (!existsSync('config/config.json')) throw new Error('config/config.json fehlt (Vorlage: config.example.json)');
if (!existsSync('config/gate.json')) throw new Error('config/gate.json fehlt (Vorlage: gate.example.json)');
const { allowedUserId } = JSON.parse(readFileSync('config/config.json', 'utf8'));
if (!allowedUserId) throw new Error('allowedUserId fehlt/0 — Whitelist-Default ist leer.');

// Kennzeichnung für Hooks: Prozesse dieser Bridge (inkl. SDK-Subprozesse/Hooks
// der Bridge-Session) melden Freigaben NICHT nochmal via /notify (Task: Go-Gate).
process.env.TELEGRAM_BRIDGE = '1';

const { bot, sendQuestion, sendText } = createBot({
  token,
  allowedUserId,
  gatePath: 'config/gate.json',
  statePath: 'data/state.json',
  projectDir: `${process.env.HOME}/.claude/projects/-Users-mca-Development-TheBrain2`,
  questionsPath: 'data/questions.json',
  answersDir: 'data/answers',
  pendingPath: 'data/pending-replies.json',
  // Optional per .env übersteuerbar (TURN_TIMEOUT_MIN, Minuten) — Default 20 min.
  turnTimeoutMs: process.env.TURN_TIMEOUT_MIN ? Number(process.env.TURN_TIMEOUT_MIN) * 60_000 : undefined,
});

startHeartbeat('data/status.json');
if (process.env.NOTIFY_TOKEN) {
  startNotifyServer({
    port: Number(process.env.NOTIFY_PORT ?? 8787),
    token: process.env.NOTIFY_TOKEN,
    send: async (text, questionId, timeoutMin) => {
      if (questionId) await sendQuestion(text, questionId, timeoutMin);
      else await sendText(allowedUserId, text); // robust: Retry + Nachliefung (#198)
    },
  });
}

// Polling-Watchdog (#198): grammY retried getUpdates-Fehler intern endlos —
// eine dauerhaft tote Schleife (z. B. SSL kaputt wie am 14.07.) fällt sonst nie
// auf. Ein API-Transformer sieht jeden getUpdates-Aufruf (bot.js fetchUpdates
// geht durch this.api → Transformer-Kette, inkl. Netzwerkfehlern); >10 min ohne
// Erfolg UND letzter Versuch fehlgeschlagen → exit(1), launchd (KeepAlive)
// startet neu, state.json resumed die Session. Stille (keine Updates) ist
// unkritisch: der 30-s-Long-Poll liefert leere Listen und zählt als Erfolg.
const watchdog = new PollWatchdog(10 * 60_000, (silenceMs) => {
  logError(
    `Watchdog: ${Math.round(silenceMs / 60_000)} min kein erfolgreicher getUpdates und letzter Versuch ` +
      'fehlgeschlagen — Polling-Schleife tot, exit(1) für launchd-Neustart.',
  );
  process.exit(1);
});
bot.api.config.use(async (prev, method, payload, signal) => {
  if (method !== 'getUpdates') return prev(method, payload, signal);
  try {
    const res = await prev(method, payload, signal);
    if (res.ok) watchdog.recordSuccess();
    else watchdog.recordFailure(); // Telegram hat geantwortet, aber mit Fehler
    return res;
  } catch (err) {
    watchdog.recordFailure(); // Netzwerk-/Transportfehler (HttpError)
    throw err;
  }
});
watchdog.start();

log('telegram-bridge: starte long-polling …');
bot.start().catch((err) => {
  logError('Fataler Start-/Polling-Fehler:', err);
  process.exit(1);
});
