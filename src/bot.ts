import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { classify, loadGateConfig } from './gate.js';
import { chunkMessage } from './chunk.js';
import { StateStore } from './state.js';
import { runTurn, type CanUseTool } from './agent.js';
import { saveIncoming, flushOutbox } from './media.js';

export type BotDeps = { token: string; allowedUserId: number; gatePath: string; statePath: string };

const GO_TIMEOUT_MS = 15 * 60 * 1000;
const startedAt = Date.now();

/**
 * `ctx.reply` mit einmaligem Retry bei Telegrams 429 (Flood-Control):
 * wartet die von Telegram vorgegebene `retry_after`-Zeit ab und versucht es
 * genau ein weiteres Mal.
 */
async function replyWithBackoff(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 429) {
      const retryAfter = err.parameters.retry_after ?? 1;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      await ctx.reply(text);
      return;
    }
    throw err;
  }
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token);
  const state = new StateStore(deps.statePath);
  const gate = loadGateConfig(deps.gatePath);
  const pendingGos = new Map<string, (ok: boolean) => void>();
  let busy = false;
  let rejectedCount = 0;

  // Whitelist: alles andere still verwerfen (nur Zähler, nie Inhalt loggen)
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== deps.allowedUserId) {
      rejectedCount++;
      return;
    }
    await next();
  });

  bot.command('new', async (ctx) => {
    if (busy) {
      await ctx.reply('⏳ Ich arbeite noch — /new bitte nochmal schicken, wenn ich fertig bin.');
      return;
    }
    state.clearSession();
    await ctx.reply('🆕 Frische Session gestartet.');
  });

  bot.command('status', async (ctx) => {
    const mins = Math.round((Date.now() - startedAt) / 60000);
    await ctx.reply(
      `✅ Bridge läuft seit ${mins} min · Session: ${state.getSessionId() ? 'aktiv' : 'keine'} · ` +
        `beschäftigt: ${busy ? 'ja' : 'nein'} · verworfene Fremd-Nachrichten: ${rejectedCount}`,
    );
  });

  // Go-Gate-Buttons
  bot.on('callback_query:data', async (ctx) => {
    const [verdict, id] = ctx.callbackQuery.data.split(':');
    const resolve = pendingGos.get(id);
    if (!resolve) {
      await ctx.answerCallbackQuery({ text: 'Abgelaufen.' });
      return;
    }
    pendingGos.delete(id);
    resolve(verdict === 'yes');
    await ctx.answerCallbackQuery({ text: verdict === 'yes' ? 'Go ✔' : 'Abgebrochen ✖' });
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  });

  const askGo = (chatId: number, toolName: string, input: unknown): Promise<boolean> =>
    new Promise((resolve) => {
      const id = randomUUID().slice(0, 8);
      const preview = JSON.stringify(input, null, 2).slice(0, 800);
      // message_id der Go-Nachricht, damit der Timeout-Fall die Buttons entfernen kann
      let messageId: number | undefined;
      const timer = setTimeout(() => {
        if (pendingGos.delete(id)) {
          resolve(false);
          if (messageId !== undefined) {
            bot.api.editMessageReplyMarkup(chatId, messageId, undefined).catch(() => {});
          }
        }
      }, GO_TIMEOUT_MS);
      pendingGos.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      // Versand awaiten statt fire-and-forget: ein Sende-Fehler (429, Netzwerk, …)
      // darf den Prozess nie crashen — im Fehlerfall wird die Runde mit "deny" fortgesetzt.
      void (async () => {
        try {
          const sent = await bot.api.sendMessage(chatId, `🚦 Go nötig für ${toolName}:\n\n${preview}`, {
            reply_markup: new InlineKeyboard().text('✅ Go', `yes:${id}`).text('❌ Stopp', `no:${id}`),
          });
          messageId = sent.message_id;
        } catch {
          if (pendingGos.delete(id)) {
            clearTimeout(timer);
            resolve(false);
          }
        }
      })();
    });

  bot.on('message', async (ctx) => {
    if (busy) {
      await ctx.reply('⏳ Ich arbeite noch an der letzten Nachricht — gleich!');
      return;
    }
    busy = true;
    const typing = setInterval(() => void ctx.replyWithChatAction('typing').catch(() => {}), 5000);
    try {
      const mediaPath = await saveIncoming(ctx, deps.token);
      let prompt = ctx.message?.text ?? ctx.message?.caption ?? '';
      if (mediaPath) prompt += `\n\n[Per Telegram geschickte Datei liegt unter: ${mediaPath}]`;
      if (!prompt.trim()) {
        await ctx.reply('Dazu fällt mir nichts ein — schick Text oder eine Datei mit Beschreibung.');
        return;
      }
      prompt +=
        '\n\n[Kontext: Nachricht kommt via Telegram-Bridge. Antworte kompakt und mobiltauglich. ' +
        'Dateien für Micha nach data/outbox/ im telegram-bridge-Repo legen.]';

      const canUseTool: CanUseTool = async (toolName, input) => {
        if (classify(gate, toolName, input) === 'go') {
          const ok = await askGo(ctx.chat.id, toolName, input);
          return ok
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Micha hat abgelehnt (oder Timeout) — Aktion nicht ausführen.' };
        }
        return { behavior: 'allow', updatedInput: input };
      };

      const answer = await runTurn({ prompt, state, canUseTool });
      for (const chunk of chunkMessage(answer)) await replyWithBackoff(ctx, chunk);
      const sent = await flushOutbox(async (p) => {
        await ctx.replyWithDocument(new InputFile(p, basename(p)));
      });
      if (sent > 0) await ctx.reply(`📎 ${sent} Datei(en) angehängt.`);
    } catch (err) {
      await ctx.reply(`💥 Fehler: ${err instanceof Error ? err.message : String(err)}\nNotfalls /new probieren.`);
    } finally {
      clearInterval(typing);
      busy = false;
    }
  });

  return bot;
}
