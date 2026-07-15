import { GrammyError, HttpError } from 'grammy';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Zentraler Send-Layer (#198): Outbound-Sends retrieten bisher nur bei 429.
// Live-Fund bridge.log 14.07.2026: SSL/EPROTO bei sendMessage — die Antwort war
// komplett weg, weil auch der Fehler-Reply im catch am selben Netzproblem
// scheiterte. Deshalb: Retry bei transienten Netzwerkfehlern + persistente
// Ablage als letzte Verteidigungslinie (Textantworten dürfen NIE verloren gehen).

export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Node-/undici-Fehlercodes, bei denen ein späterer Versuch Erfolg verspricht. */
const TRANSIENT_CODES = new Set([
  'EPROTO', // SSL-Handshake kaputt (der Live-Fund vom 14.07.)
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN', // DNS temporär nicht auflösbar
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT', // undici (Node-fetch)
  'UND_ERR_SOCKET',
]);

/**
 * Transient = Netzwerk-/Transportproblem, kein API-Verdikt. grammY verpackt
 * fetch-Fehler in HttpError; rohe fetch/Node-Fehler tragen `code` (ggf. in
 * `cause` verschachtelt, Node wrappt "fetch failed" um den echten Fehler).
 * GrammyError (Telegram hat geantwortet, aber abgelehnt) ist NICHT transient —
 * einzige Ausnahme 429, das behandelt sendWithRetry separat via retry_after.
 */
export function isTransientSendError(err: unknown): boolean {
  if (err instanceof HttpError) return true;
  if (err instanceof GrammyError) return false;
  for (let e = err, depth = 0; typeof e === 'object' && e !== null && depth < 5; depth++) {
    const { code, name, cause } = e as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    if (name === 'FetchError') return true;
    e = cause as never;
  }
  return false;
}

export type RetryOptions = {
  /** Gesamtzahl Versuche (inkl. erstem), Default 5. */
  attempts?: number;
  /** Startverzögerung, verdoppelt sich je Versuch: 8+16+32+64 s ≈ 2 min. */
  baseDelayMs?: number;
  /** Injizierbar für Tests. */
  sleep?: SleepFn;
};

/**
 * Führt einen Send aus und retried transiente Netzwerkfehler mit exponentiellem
 * Backoff; Telegrams 429 wartet stattdessen das vorgegebene retry_after ab
 * (zählt aber gegen dasselbe Versuchs-Budget). Nicht-transiente Fehler
 * (z. B. 400 Bad Request) fliegen sofort — Retry würde nur wiederholen.
 */
export async function sendWithRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? realSleep;
  let delay = opts.baseDelayMs ?? 8_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryAfterMs =
        err instanceof GrammyError && err.error_code === 429
          ? (err.parameters.retry_after ?? 1) * 1000
          : undefined;
      if (attempt >= attempts || (retryAfterMs === undefined && !isTransientSendError(err))) throw err;
      await sleep(retryAfterMs ?? delay);
      if (retryAfterMs === undefined) delay *= 2;
    }
  }
}

export type PendingReply = { chatId: number; text: string; timestamp: string };

/**
 * Persistente Ablage für Textantworten, deren Versand endgültig gescheitert ist
 * (alle Retries verbraucht). Ein Flush-Timer liefert sie mit "(verspätet)"-Präfix
 * nach, sobald das Netz wieder trägt — auch über einen Prozess-Neustart hinweg.
 */
export class PendingReplyStore {
  private data: PendingReply[] = [];
  constructor(private filePath: string) {
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        this.data = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.data = [];
      }
    }
  }
  add(chatId: number, text: string): void {
    this.data.push({ chatId, text, timestamp: new Date().toISOString() });
    this.save();
  }
  list(): PendingReply[] {
    return [...this.data];
  }
  /**
   * Versucht die Nachliefung in Original-Reihenfolge; beim ersten Fehler wird
   * abgebrochen (nicht weiterprobiert), damit Antworten nie vertauscht ankommen.
   * Erfolgreich Gesendetes wird sofort persistent entfernt — ein Crash mitten im
   * Flush kostet so schlimmstenfalls ein Duplikat, nie eine Antwort.
   */
  async flush(send: (chatId: number, text: string) => Promise<void>): Promise<number> {
    let sent = 0;
    while (this.data.length > 0) {
      const next = this.data[0];
      try {
        await send(next.chatId, `(verspätet) ${next.text}`);
      } catch {
        break;
      }
      this.data.shift();
      this.save();
      sent++;
    }
    return sent;
  }
  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

/**
 * Flush-Timer: liefert liegengebliebene Antworten periodisch nach. `send` wird
 * OHNE eigenes Retry aufgerufen — schlägt es fehl, kommt der nächste Tick in
 * einer Minute sowieso (Retry-Kaskaden im Timer würden sich nur stapeln).
 */
export function startPendingFlush(
  store: PendingReplyStore,
  send: (chatId: number, text: string) => Promise<void>,
  intervalMs = 60_000,
): NodeJS.Timeout {
  let running = false; // Überlappungsschutz, falls ein Flush länger als ein Tick dauert
  const timer = setInterval(async () => {
    if (running || store.list().length === 0) return;
    running = true;
    try {
      await store.flush(send);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
