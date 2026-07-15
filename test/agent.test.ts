import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, TurnTimeoutError } from '../src/agent.js';
import { StateStore } from '../src/state.js';

// SDK mocken: 'ok' liefert einen normalen Turn, 'hang' hängt für immer —
// außer der (vom Timeout ausgelöste) Abort bricht ihn ab, wie das echte SDK.
const h = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'hang',
  options: undefined as { abortController?: AbortController } | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: { abortController?: AbortController } }) => {
    h.options = args.options;
    if (h.mode === 'ok') {
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's-1' };
        yield { type: 'result', subtype: 'success', session_id: 's-1', result: 'Antwort!' };
      })();
    }
    return (async function* () {
      const signal = args.options.abortController?.signal;
      yield await new Promise((_, reject) => {
        if (!signal) return; // kein Abort möglich → hängt wirklich für immer
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    })();
  },
}));

const freshState = () => new StateStore(join(mkdtempSync(join(tmpdir(), 'tb-agent-')), 'state.json'));
const allow = async (_tool: string, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input }) as const;

beforeEach(() => {
  vi.useFakeTimers();
  h.mode = 'ok';
  h.options = undefined;
});
afterEach(() => vi.useRealTimers());

describe('runTurn Timeout', () => {
  it('normaler Turn liefert die Antwort und bricht nichts ab', async () => {
    const state = freshState();
    const answer = await runTurn({ prompt: 'hi', state, canUseTool: allow });
    expect(answer).toBe('Antwort!');
    expect(state.getSessionId()).toBe('s-1');
    // Timeout-Timer wurde aufgeräumt, nichts abgebrochen
    expect(h.options?.abortController?.signal.aborted).toBe(false);
  });

  it('hängender Turn wird nach Default 20 min abgebrochen (TurnTimeoutError)', async () => {
    h.mode = 'hang';
    const p = runTurn({ prompt: 'hi', state: freshState(), canUseTool: allow });
    const assertion = expect(p).rejects.toBeInstanceOf(TurnTimeoutError);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await assertion;
    // Abort ging ans SDK durch (AbortController-Support der query-Options)
    expect(h.options?.abortController?.signal.aborted).toBe(true);
  });

  it('Timeout ist konfigurierbar und die Meldung nennt die Minuten', async () => {
    h.mode = 'hang';
    const p = runTurn({ prompt: 'hi', state: freshState(), canUseTool: allow, timeoutMs: 5 * 60_000 });
    const assertion = expect(p).rejects.toThrow(/5 min/);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await assertion;
  });
});
