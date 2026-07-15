import { describe, it, expect } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendWithRetry, isTransientSendError, PendingReplyStore } from '../src/send.js';

/** Aufgezeichneter Sleep — Tests laufen ohne echte Wartezeit. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

const grammy429 = () =>
  new GrammyError(
    'Call failed',
    { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } },
    'sendMessage',
    {},
  );

const grammy400 = () =>
  new GrammyError('Call failed', { ok: false, error_code: 400, description: 'Bad Request' }, 'sendMessage', {});

const eproto = () => Object.assign(new Error('write EPROTO 80B0…: ssl error'), { code: 'EPROTO' });

describe('isTransientSendError', () => {
  it('erkennt grammY HttpError (Netzwerk-Ebene) als transient', () => {
    expect(isTransientSendError(new HttpError('Network request failed', new Error('boom')))).toBe(true);
  });
  it('erkennt Node-Netzwerkfehler über code (EPROTO/ETIMEDOUT/ECONNRESET/EAI_AGAIN)', () => {
    for (const code of ['EPROTO', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
      expect(isTransientSendError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });
  it('erkennt FetchError und verschachtelte cause-Codes', () => {
    const fetchErr = Object.assign(new Error('request failed'), { name: 'FetchError' });
    expect(isTransientSendError(fetchErr)).toBe(true);
    const wrapped = new Error('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });
    expect(isTransientSendError(wrapped)).toBe(true);
  });
  it('stuft Telegram-API-Fehler (GrammyError 400) NICHT als transient ein', () => {
    expect(isTransientSendError(grammy400())).toBe(false);
  });
});

describe('sendWithRetry', () => {
  it('gibt beim ersten Erfolg direkt zurück (kein Sleep)', async () => {
    const { waits, sleep } = fakeSleep();
    const result = await sendWithRetry(async () => 42, { sleep });
    expect(result).toBe(42);
    expect(waits).toEqual([]);
  });

  it('retried transiente Fehler mit exponentiellem Backoff und liefert den späten Erfolg', async () => {
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    const result = await sendWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw eproto();
        return 'ok';
      },
      { sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([8_000, 16_000]);
  });

  it('gibt nach 5 Versuchen (~2 min Backoff) auf und wirft den letzten Fehler', async () => {
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    await expect(
      sendWithRetry(
        async () => {
          calls++;
          throw eproto();
        },
        { sleep },
      ),
    ).rejects.toThrow('EPROTO');
    expect(calls).toBe(5);
    // 8+16+32+64 s = 120 s ≈ 2 Minuten Gesamt-Backoff
    expect(waits).toEqual([8_000, 16_000, 32_000, 64_000]);
  });

  it('respektiert bei 429 das retry_after von Telegram', async () => {
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    const result = await sendWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw grammy429();
        return 'ok';
      },
      { sleep },
    );
    expect(result).toBe('ok');
    expect(waits).toEqual([7_000]);
  });

  it('wirft nicht-transiente Fehler sofort (kein Retry bei 400)', async () => {
    const { waits, sleep } = fakeSleep();
    let calls = 0;
    await expect(
      sendWithRetry(
        async () => {
          calls++;
          throw grammy400();
        },
        { sleep },
      ),
    ).rejects.toThrow('Bad Request');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe('PendingReplyStore', () => {
  const setup = () => join(mkdtempSync(join(tmpdir(), 'tb-pending-')), 'pending-replies.json');

  it('persistiert Einträge und lädt sie nach Neustart wieder', () => {
    const file = setup();
    const store = new PendingReplyStore(file);
    store.add(123, 'Hallo Micha');
    const reloaded = new PendingReplyStore(file);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({ chatId: 123, text: 'Hallo Micha' });
    expect(reloaded.list()[0].timestamp).toBeTruthy();
    // Datei ist echtes JSON auf Platte
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('flush sendet mit "(verspätet)"-Präfix und leert den Store bei Erfolg', async () => {
    const file = setup();
    const store = new PendingReplyStore(file);
    store.add(123, 'Antwort A');
    store.add(123, 'Antwort B');
    const sent: Array<{ chatId: number; text: string }> = [];
    const count = await store.flush(async (chatId, text) => void sent.push({ chatId, text }));
    expect(count).toBe(2);
    expect(sent.map((s) => s.text)).toEqual(['(verspätet) Antwort A', '(verspätet) Antwort B']);
    expect(store.list()).toEqual([]);
    expect(new PendingReplyStore(file).list()).toEqual([]);
  });

  it('flush stoppt beim ersten Fehler und behält Rest in Reihenfolge (nichts geht verloren)', async () => {
    const file = setup();
    const store = new PendingReplyStore(file);
    store.add(123, 'A');
    store.add(123, 'B');
    let calls = 0;
    const count = await store.flush(async () => {
      calls++;
      throw eproto();
    });
    expect(count).toBe(0);
    expect(calls).toBe(1); // nach erstem Fehler abbrechen — Reihenfolge bleibt erhalten
    expect(store.list().map((p) => p.text)).toEqual(['A', 'B']);
  });

  it('übersteht kaputten State (valides JSON, aber kein Array)', () => {
    const file = setup();
    const store = new PendingReplyStore(file);
    store.add(1, 'x');
    // Datei von Hand kaputt machen
    writeFileSync(file, '{"nicht":"ein array"}');
    expect(new PendingReplyStore(file).list()).toEqual([]);
  });
});
