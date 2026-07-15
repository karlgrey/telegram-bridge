// Inbound-Queue (#198): Vorher verwarf ein busy-Flag jede Nachricht, die während
// eines laufenden Turns ankam („⏳ Ich arbeite noch") — die Nachricht war WEG.
// Jetzt: FIFO-Queue, ein Turn zur Zeit (die Claude-Session ist sequenziell),
// eingereihte Nachrichten laufen nach dem aktuellen Turn automatisch weiter.

export type EnqueueResult = 'started' | 'queued' | 'full';

export class TurnQueue<T> {
  private items: T[] = [];
  private running = false;

  constructor(
    private run: (item: T) => Promise<void>,
    private limit = 10,
    // Sicherheitsnetz: run() fängt in der Praxis selbst (bot.ts try/catch) —
    // aber ein durchgerutschter Fehler darf die Abarbeitung nie stilllegen.
    private onError: (err: unknown) => void = () => {},
  ) {}

  /** Läuft gerade ein Turn (Ersatz für das frühere busy-Flag)? */
  get busy(): boolean {
    return this.running;
  }

  /** Anzahl wartender Nachrichten (ohne den laufenden Turn). */
  get length(): number {
    return this.items.length;
  }

  /**
   * 'started' = keine Wartesituation, Turn läuft sofort (Verhalten wie früher);
   * 'queued'  = ein Turn läuft, Nachricht eingereiht (Bestätigung schicken);
   * 'full'    = Limit erreicht, Nachricht NICHT angenommen (klar melden).
   * Kehrt synchron zurück — die Abarbeitung läuft detached, damit grammYs
   * sequenzielle Update-Schleife nie blockiert (Deadlock-Fix 10.07.2026).
   */
  enqueue(item: T): EnqueueResult {
    if (this.running) {
      if (this.items.length >= this.limit) return 'full';
      this.items.push(item);
      return 'queued';
    }
    this.running = true;
    void this.drain(item);
    return 'started';
  }

  private async drain(first: T): Promise<void> {
    let current: T | undefined = first;
    while (current !== undefined) {
      try {
        await this.run(current);
      } catch (err) {
        this.onError(err);
      }
      current = this.items.shift();
    }
    this.running = false;
  }
}
