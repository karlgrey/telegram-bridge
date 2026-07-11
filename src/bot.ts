import { Bot, GrammyError, InlineKeyboard, InputFile, type Context, type Filter } from 'grammy';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { classify, loadGateConfig } from './gate.js';
import { chunkMessage } from './chunk.js';
import { StateStore } from './state.js';
import { runTurn, type CanUseTool } from './agent.js';
import { saveIncoming, flushOutbox, OUTBOX } from './media.js';
import { claudeProcessRunning, formatSessions, listSessions } from './sessions.js';
import { QuestionStore } from './questions.js';

export type BotDeps = {
  token: string;
  allowedUserId: number;
  gatePath: string;
  statePath: string;
  projectDir: string;
  questionsPath: string;
  answersDir: string;
};

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

export type BridgeBot = { bot: Bot; sendQuestion: (text: string, questionId: string) => Promise<void> };

export function createBot(deps: BotDeps): BridgeBot {
  const bot = new Bot(deps.token);
  // Unbehandelte Fehler aus Handlern nie den Prozess crashen lassen — nur das
  // betroffene Update überspringen und weiterlaufen (grammY-Fehlerkanal).
  bot.catch((err) => console.error('Bot-Fehler (Update übersprungen):', err));
  const state = new StateStore(deps.statePath);
  const gate = loadGateConfig(deps.gatePath);
  const questions = new QuestionStore(deps.questionsPath, deps.answersDir);
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

  bot.command('sessions', async (ctx) => {
    try {
      const sessions = await listSessions({
        projectDir: deps.projectDir,
        excludeIds: state.getBridgeSessionIds(),
      });
      await ctx.reply(formatSessions(sessions, claudeProcessRunning()));
    } catch (err) {
      await ctx.reply(`💥 /sessions fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  // WICHTIG: grammY verarbeitet Updates sequenziell (bot.js: for-Schleife über
  // handleUpdates). Der Turn darf die Update-Schleife deshalb NICHT blockieren —
  // sonst kann der Go/Stopp-Button-Callback (selbst ein Update) nie verarbeitet
  // werden und askGo deadlockt bis zum Timeout (Live-Fund Abnahme 10.07.2026).
  // Daher: Handler kehrt sofort zurück, der Turn läuft detached weiter.
  bot.on('message', (ctx) => {
    void handleMessage(ctx).catch((err) => console.error('Turn-Fehler (detached):', err));
  });

  const handleMessage = async (ctx: Filter<Context, 'message'>) => {
    // Reply auf einen Rückfrage-Push? → Antwort-Datei schreiben, kein Agent-Turn.
    const replyTo = ctx.message?.reply_to_message?.message_id;
    if (replyTo !== undefined) {
      const answerText = ctx.message?.text ?? ctx.message?.caption ?? '';
      if (questions.isOpenQuestion(replyTo) && !answerText.trim()) {
        await ctx.reply('Bitte als Text antworten — die Session wartet auf eine Text-Antwort.');
        return;
      }
      const verdict = questions.answerByMessageId(replyTo, answerText.trim());
      if (verdict === 'answered') {
        await ctx.reply('✔ Antwort an die wartende Session weitergereicht.');
        return;
      }
      if (verdict === 'stale') {
        await ctx.reply('Diese Frage ist nicht mehr offen (schon beantwortet oder abgelaufen).');
        return;
      }
      // 'none': Reply auf normale Bot-Nachricht → als normale Nachricht behandeln
    }
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
        `Dateien für Micha nach ${OUTBOX} legen.]`;

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
  };

  const sendQuestion = async (text: string, questionId: string): Promise<void> => {
    // force_reply: öffnet beim Empfänger automatisch den Antworten-Modus —
    // einfaches Tippen erzeugt so den echten Telegram-Reply, den das Routing
    // braucht (Live-Fund Abnahme 11.07.2026: direkt getippte Antworten kamen
    // ohne reply_to_message an und liefen als normaler Agent-Turn).
    const sent = await bot.api.sendMessage(
      deps.allowedUserId,
      `❓ Rückfrage einer Laptop-Session — antworte einfach auf diese Nachricht:\n\n${text}`,
      { reply_markup: { force_reply: true } },
    );
    questions.register(questionId, sent.message_id);
  };

  return { bot, sendQuestion };
}
