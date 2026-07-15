import { describe, it, expect } from 'vitest';
import { TurnQueue } from '../src/queue.js';

/** Steuerbarer Task: läuft, bis der Test ihn explizit auflöst. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('TurnQueue', () => {
  it('erste Nachricht startet sofort (started, keine Wartesituation)', async () => {
    const ran: string[] = [];
    const q = new TurnQueue<string>(async (item) => void ran.push(item));
    expect(q.enqueue('a')).toBe('started');
    await tick();
    expect(ran).toEqual(['a']);
    expect(q.busy).toBe(false);
  });

  it('während eines Turns wird eingereiht (queued) und danach FIFO abgearbeitet', async () => {
    const gate = deferred();
    const ran: string[] = [];
    const q = new TurnQueue<string>(async (item) => {
      ran.push(item);
      if (item === 'a') await gate.promise;
    });
    expect(q.enqueue('a')).toBe('started');
    expect(q.enqueue('b')).toBe('queued');
    expect(q.enqueue('c')).toBe('queued');
    expect(q.busy).toBe(true);
    expect(q.length).toBe(2);
    expect(ran).toEqual(['a']); // b/c warten — ein Turn zur Zeit
    gate.resolve();
    await tick();
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(q.busy).toBe(false);
    expect(q.length).toBe(0);
  });

  it('lehnt bei vollem Limit ab (full) und verarbeitet den Überlauf nicht', async () => {
    const gate = deferred();
    const ran: string[] = [];
    const q = new TurnQueue<string>(
      async (item) => {
        ran.push(item);
        if (item === 'a') await gate.promise;
      },
      2, // Limit
    );
    q.enqueue('a');
    expect(q.enqueue('b')).toBe('queued');
    expect(q.enqueue('c')).toBe('queued');
    expect(q.enqueue('d')).toBe('full');
    gate.resolve();
    await tick();
    expect(ran).toEqual(['a', 'b', 'c']); // d wurde nie angenommen
  });

  it('nach dem Leerlaufen startet die nächste Nachricht wieder sofort', async () => {
    const q = new TurnQueue<string>(async () => {});
    q.enqueue('a');
    await tick();
    expect(q.enqueue('b')).toBe('started');
  });

  it('ein geworfener Turn stoppt die Queue nicht (Fehler geht an onError)', async () => {
    const errors: unknown[] = [];
    const ran: string[] = [];
    const q = new TurnQueue<string>(
      async (item) => {
        if (item === 'kaputt') throw new Error('boom');
        ran.push(item);
      },
      10,
      (err) => void errors.push(err),
    );
    q.enqueue('kaputt');
    expect(q.enqueue('heil')).toBe('queued');
    await tick();
    expect(ran).toEqual(['heil']);
    expect(errors).toHaveLength(1);
    expect(q.busy).toBe(false);
  });
});
