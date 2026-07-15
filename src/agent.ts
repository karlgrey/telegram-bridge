import { query } from '@anthropic-ai/claude-agent-sdk';
import type { StateStore } from './state.js';

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
>;

export type RunTurnOptions = {
  prompt: string;
  state: StateStore;
  canUseTool: CanUseTool;
  onProgress?: (note: string) => void;
  /** Hard-Timeout für den ganzen Turn; Default 20 min (#198). */
  timeoutMs?: number;
};

const CWD = '/Users/mca/Development/TheBrain2';
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;

/** Turn hat das Hard-Timeout gerissen — Aufrufer informiert Micha und macht mit der Queue weiter. */
export class TurnTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Turn abgebrochen nach ${Math.round(timeoutMs / 60_000)} min`);
    this.name = 'TurnTimeoutError';
  }
}

/**
 * Ein Gesprächszug: Session resumen, Antworttext einsammeln, Session-ID sichern.
 *
 * Hard-Timeout (#198): Ohne Timeout ließ ein hängender SDK-Turn die Queue für
 * immer blockieren — der Bot wirkte tot. Das SDK unterstützt `abortController`
 * in den query-Options („When aborted, the query will stop and clean up
 * resources"), also brechen wir darüber sauber ab statt per Promise.race.
 */
export async function runTurn(opts: RunTurnOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  const pieces: string[] = [];
  const response = query({
    prompt: opts.prompt,
    options: {
      cwd: CWD,
      resume: opts.state.getSessionId(),
      abortController,
      // ACHTUNG — zwei bekannte blinde Flecken des Go-Gates (siehe README,
      // Abschnitt "Grenzen des Go-Gates"):
      // 1. `acceptEdits` genehmigt datei-editierende Tools (Write/Edit/…) automatisch
      //    auf SDK-Ebene, bevor `canUseTool` überhaupt feuert — das Gate sieht diese
      //    Calls nie und kann sie folglich nie stoppen.
      // 2. `settingSources: ['user', 'project']` zieht Allow-Regeln aus Michas/dem
      //    Projekt-Settings (z. B. `.claude/settings.json`) — dort erlaubte Tools
      //    umgehen den `canUseTool`-Hook ebenfalls.
      // In der Praxis gated das Go-Gate damit zuverlässig nur Bash & Co., nicht
      // jeden möglichen Tool-Call.
      permissionMode: 'acceptEdits',
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Echte SDK-Signatur hat einen dritten `options`-Parameter (signal, requestId, …)
      // und erwartet `Promise<PermissionResult | null>` — unser eigener CanUseTool-Typ
      // (2 Argumente, kein `null`) ist eine schmalere Fassade darüber und strukturell
      // kompatibel zur `allow`/`deny`-Variante von `PermissionResult`.
      canUseTool: async (toolName, input) => {
        opts.onProgress?.(`🔧 ${toolName}`);
        return opts.canUseTool(toolName, input);
      },
    },
  });
  try {
    for await (const message of response) {
      if (message.type === 'system' && message.subtype === 'init') {
        opts.state.setSessionId(message.session_id);
      }
      if (message.type === 'result') {
        opts.state.setSessionId(message.session_id);
        if (message.subtype === 'success') pieces.push(message.result);
        else pieces.push(`⚠️ Session-Fehler: ${message.subtype}`);
      }
    }
  } catch (err) {
    // Nach Abort wirft das SDK (AbortError o. Ä.) — als Timeout ausweisen,
    // alles andere unverändert durchreichen.
    if (timedOut) throw new TurnTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  // Falls der Iterator nach dem Abort still endet statt zu werfen:
  if (timedOut) throw new TurnTimeoutError(timeoutMs);
  return pieces.join('\n\n') || '⚠️ Keine Antwort erhalten.';
}
