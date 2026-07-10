import { existsSync, readFileSync } from 'node:fs';
import { createBot } from './bot.js';
import { startNotifyServer } from './notify.js';
import { startHeartbeat } from './status.js';

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

const bot = createBot({
  token,
  allowedUserId,
  gatePath: 'config/gate.json',
  statePath: 'data/state.json',
});

startHeartbeat('data/status.json');
if (process.env.NOTIFY_TOKEN) {
  startNotifyServer({
    port: Number(process.env.NOTIFY_PORT ?? 8787),
    token: process.env.NOTIFY_TOKEN,
    send: async (text) => void (await bot.api.sendMessage(allowedUserId, text)),
  });
}

console.log('telegram-bridge: starte long-polling …');
bot.start().catch((err) => {
  console.error('Fataler Start-/Polling-Fehler:', err);
  process.exit(1);
});
