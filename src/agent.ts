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
};

const CWD = '/Users/mca/Development/TheBrain2';

/** Ein Gesprächszug: Session resumen, Antworttext einsammeln, Session-ID sichern. */
export async function runTurn(opts: RunTurnOptions): Promise<string> {
  const pieces: string[] = [];
  const response = query({
    prompt: opts.prompt,
    options: {
      cwd: CWD,
      resume: opts.state.getSessionId(),
      permissionMode: 'acceptEdits',
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Echte SDK-Signatur hat einen dritten `options`-Parameter (signal, requestId, …)
      // und erwartet `Promise<PermissionResult | null>` — unser eigener CanUseTool-Typ
      // (2 Argumente, kein `null`) ist eine schmalere Fassade darüber und strukturell
      // kompatibel zur `allow`/`deny`-Variante von `PermissionResult`.
      canUseTool: async (toolName, input) => {
        opts.onProgress?.(`🔧 ${toolName}`);
        return opts.canUseTool(toolName, input as Record<string, unknown>);
      },
    },
  });
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
  return pieces.join('\n\n') || '⚠️ Keine Antwort erhalten.';
}
