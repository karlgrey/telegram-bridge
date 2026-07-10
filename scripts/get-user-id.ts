import { existsSync, readFileSync } from 'node:fs';
import { Bot } from 'grammy';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
bot.on('message', (ctx) => {
  console.log(`User-ID: ${ctx.from.id} (${ctx.from.first_name}) — diese ID als allowedUserId eintragen, dann Ctrl+C.`);
});
console.log('Schick dem Bot jetzt eine Nachricht …');
void bot.start();
