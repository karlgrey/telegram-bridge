import { Bot, InlineKeyboard, InputFile, type Context, type Filter } from 'grammy';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { classify, loadGateConfig } from './gate.js';
import { chunkMessage } from './chunk.js';
import { StateStore } from './state.js';
import { runTurn, TurnTimeoutError, type CanUseTool } from './agent.js';
import { saveIncoming, flushOutbox, OUTBOX } from './media.js';
import { claudeProcessRunning, formatSessions, listSessions } from './sessions.js';
import { QuestionStore } from './questions.js';
import { PendingReplyStore, sendWithRetry, startPendingFlush } from './send.js';
import { TurnQueue } from './queue.js';
import { logError } from './log.js';

export type BotDeps = {
  token: string;
  allowedUserId: number;
  gatePath: string;
  statePath: string;
  projectDir: string;
  questionsPath: string;
  answersDir: string;
  pendingPath: string;
  /** Hard-Timeout pro Agent-Turn in ms; Default 20 min (siehe agent.ts, #198). */
  turnTimeoutMs?: number;
};

const GO_TIMEOUT_MS = 15 * 60 * 1000;
const QUEUE_LIMIT = 10;
const startedAt = Date.now();

export type BridgeBot = {
  bot: Bot;
  sendQuestion: (text: string, questionId: string, timeoutMin?: number) => Promise<void>;
  /** Robuster Text-Versand (Retry + persistente Nachliefung) — auch für /notify. */
  sendText: (chatId: number, text: string) => Promise<void>;
};

export function createBot(deps: BotDeps): BridgeBot {
  const bot = new Bot(deps.token);
  // Unbehandelte Fehler aus Handlern nie den Prozess crashen lassen — nur das
  // betroffene Update überspringen und weiterlaufen (grammY-Fehlerkanal).
  bot.catch((err) => logError('Bot-Fehler (Update übersprungen):', err));
  const state = new StateStore(deps.statePath);
  const gate = loadGateConfig(deps.gatePath);
  const questions = new QuestionStore(deps.questionsPath, deps.answersDir);
  const pendingGos = new Map<string, (ok: boolean) => void>();
  let rejectedCount = 0;

  // Robuster Send-Layer (#198): Retry bei transienten Netzwerkfehlern; scheitern
  // alle Versuche, landet der Text persistent in pending-replies.json und der
  // Flush-Timer liefert ihn "(verspätet)" nach — Antworten gehen NIE mehr verloren.
  const pendingReplies = new PendingReplyStore(deps.pendingPath);
  const sendText = async (chatId: number, text: string): Promise<void> => {
    try {
      await sendWithRetry(() => bot.api.sendMessage(chatId, text));
    } catch (err) {
      pendingReplies.add(chatId, text);
      logError('Send endgültig fehlgeschlagen — Antwort nach pending-replies.json gelegt:', err);
    }
  };
  // Flush ohne eigenes Retry: klappt der Tick nicht, kommt der nächste in 60 s.
  startPendingFlush(pendingReplies, async (chatId, text) => {
    await bot.api.sendMessage(chatId, text);
  });

  // Whitelist: alles andere still verwerfen (nur Zähler, nie Inhalt loggen)
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== deps.allowedUserId) {
      rejectedCount++;
      return;
    }
    await next();
  });

  bot.command('new', async (ctx) => {
    if (turnQueue.busy || turnQueue.length > 0) {
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
        `beschäftigt: ${turnQueue.busy ? 'ja' : 'nein'} · wartend: ${turnQueue.length} · ` +
        `verworfene Fremd-Nachrichten: ${rejectedCount}`,
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
      // Mit Retry (#198): eine transiente Netz-Delle soll kein Deny erzwingen; die
      // Go-Frage ist zeitkritisch (15-min-Timeout), Persistenz ergäbe hier keinen Sinn.
      void (async () => {
        try {
          const sent = await sendWithRetry(() =>
            bot.api.sendMessage(chatId, `🚦 Go nötig für ${toolName}:\n\n${preview}`, {
              reply_markup: new InlineKeyboard().text('✅ Go', `yes:${id}`).text('❌ Stopp', `no:${id}`),
            }),
          );
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
  // Daher: Handler kehrt sofort zurück; routeMessage bedient die Sonderpfade
  // (Rückfrage-Antworten) SOFORT und reiht Agent-Turns nur in die Queue ein —
  // deren Abarbeitung läuft detached (TurnQueue.drain), nie in der Update-Schleife.
  bot.on('message', (ctx) => {
    void routeMessage(ctx).catch((err) => logError('Routing-Fehler (detached):', err));
  });

  const routeMessage = async (ctx: Filter<Context, 'message'>) => {
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

    // Fallback (Live-Fund Abnahme 11.07.2026): direkt getippte Antworten tragen
    // kein reply_to_message, und force_reply greift nicht zuverlässig bei offenem
    // Chat. Wartet genau EINE Rückfrage (nicht abgelaufen), wird eine normale
    // Textnachricht als deren Antwort gewertet — mit expliziter Bestätigung,
    // damit nie etwas still als Antwort verschwindet.
    if (replyTo === undefined) {
      const open = questions.openQuestions();
      const answerText = (ctx.message?.text ?? ctx.message?.caption ?? '').trim();
      if (open.length === 1 && answerText && !answerText.startsWith('/')) {
        questions.answerByMessageId(open[0].messageId, answerText);
        await ctx.reply('✔ Als Antwort auf die offene Rückfrage gewertet und an die wartende Session weitergereicht.');
        return;
      }
    }
    // Kein Sonderpfad → Agent-Turn. Statt Verwerfen bei busy (früher: „⏳ Ich
    // arbeite noch" und die Nachricht war WEG) jetzt einreihen (#198).
    const verdict = turnQueue.enqueue(ctx);
    if (verdict === 'queued') {
      await ctx.reply(`⏳ Eingereiht (Platz ${turnQueue.length}) — ich melde mich, sobald ich dran bin.`);
    } else if (verdict === 'full') {
      await ctx.reply(
        `🛑 Warteschlange voll (${QUEUE_LIMIT}) — diese Nachricht wurde NICHT angenommen, bitte später erneut schicken.`,
      );
    }
    // 'started': keine Wartesituation — Verhalten wie bisher, keine Extra-Meldung.
  };

  /** Ein kompletter Agent-Turn für eine Nachricht — läuft ausschließlich über die Queue. */
  const runAgentTurn = async (ctx: Filter<Context, 'message'>) => {
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

      const answer = await runTurn({ prompt, state, canUseTool, timeoutMs: deps.turnTimeoutMs });
      for (const chunk of chunkMessage(answer)) await sendText(ctx.chat.id, chunk);
      // Dokument-Anhänge: Retry ja, aber keine Persistenz-Schicht nötig — die Datei
      // liegt ohnehin im Outbox-Ordner (flushOutbox verschiebt erst NACH erfolgreichem
      // Send nach sent/), der nächste Turn-Flush nimmt sie automatisch wieder mit.
      try {
        const sent = await flushOutbox(async (p) => {
          await sendWithRetry(() => ctx.replyWithDocument(new InputFile(p, basename(p))));
        });
        if (sent > 0) await sendText(ctx.chat.id, `📎 ${sent} Datei(en) angehängt.`);
      } catch (err) {
        await sendText(
          ctx.chat.id,
          `📎 Datei-Versand fehlgeschlagen (${err instanceof Error ? err.message : String(err)}) — ` +
            'Datei bleibt in der Outbox und geht beim nächsten Turn mit raus.',
        );
      }
    } catch (err) {
      // Fehler-Reply ebenfalls über den robusten Layer — Live-Fund 14.07.2026:
      // genau dieser Reply ging beim SSL/EPROTO-Ausfall mit unter.
      if (err instanceof TurnTimeoutError) {
        // Queue läuft danach automatisch weiter (finally im TurnQueue-Drain).
        await sendText(ctx.chat.id, `⏱ ${err.message} — /new falls die Session klemmt.`);
      } else {
        await sendText(
          ctx.chat.id,
          `💥 Fehler: ${err instanceof Error ? err.message : String(err)}\nNotfalls /new probieren.`,
        );
      }
    } finally {
      clearInterval(typing);
    }
  };

  // Ein Turn zur Zeit (die Claude-Session ist sequenziell), FIFO, Limit 10.
  // runAgentTurn fängt selbst alles — onError ist nur das letzte Sicherheitsnetz,
  // damit die Queue nie stehen bleibt.
  const turnQueue = new TurnQueue<Filter<Context, 'message'>>(runAgentTurn, QUEUE_LIMIT, (err) =>
    logError('Turn-Fehler (Queue-Sicherheitsnetz):', err),
  );

  const sendQuestion = async (text: string, questionId: string, timeoutMin?: number): Promise<void> => {
    // force_reply: öffnet beim Empfänger automatisch den Antworten-Modus —
    // einfaches Tippen erzeugt so den echten Telegram-Reply, den das Routing
    // braucht (Live-Fund Abnahme 11.07.2026: direkt getippte Antworten kamen
    // ohne reply_to_message an und liefen als normaler Agent-Turn).
    const sent = await sendWithRetry(() =>
      bot.api.sendMessage(
        deps.allowedUserId,
        `❓ Rückfrage einer Laptop-Session — antworte einfach auf diese Nachricht:\n\n${text}`,
        { reply_markup: { force_reply: true } },
      ),
    );
    questions.register(questionId, sent.message_id, Date.now(), timeoutMin);
  };

  return { bot, sendQuestion, sendText };
}
