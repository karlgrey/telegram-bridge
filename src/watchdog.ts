// Polling-Watchdog (#198): grammYs Long-Polling-Schleife retried getUpdates-
// Fehler intern für immer (bot.js handlePollingError, 3-s-Sleep) — nach außen
// sieht ein dauerhaft kaputtes Netz genauso aus wie Stille. Der Watchdog
// beobachtet die getUpdates-Aufrufe über einen API-Transformer (Verdrahtung in
// main.ts) und lässt den Prozess sterben, wenn die Schleife nachweislich tot
// ist — launchd (KeepAlive) startet neu, state.json resumed die Session.
//
// False-Positive-Schutz: KEINE Updates zu bekommen ist NORMAL (Stille) — der
// 30-s-Long-Poll liefert dann einfach leere Listen und zählt als Erfolg. Tot
// heißt: >10 min kein erfolgreicher getUpdates UND der letzte Versuch schlug
// fehl. Ein hängender Request (weder Erfolg noch Fehler) löst nicht aus; er
// läuft in grammYs Client-Timeout und wird dadurch zum registrierten Fehler.

export class PollWatchdog {
  private lastSuccess: number;
  private lastFailure = 0;

  constructor(
    private maxSilenceMs: number,
    private onDead: (silenceMs: number) => void,
    now = Date.now(),
  ) {
    // Startzeit als "letzter Erfolg" werten — sonst könnte ein Neustart in eine
    // laufende Störung hinein sofort wieder exiten (Restart-Schleife).
    this.lastSuccess = now;
  }

  recordSuccess(now = Date.now()): void {
    this.lastSuccess = now;
  }

  recordFailure(now = Date.now()): void {
    this.lastFailure = now;
  }

  /** true = Polling-Schleife gilt als tot; onDead wurde gerufen. */
  check(now = Date.now()): boolean {
    const silence = now - this.lastSuccess;
    const dead = silence > this.maxSilenceMs && this.lastFailure > this.lastSuccess;
    if (dead) this.onDead(silence);
    return dead;
  }

  start(intervalMs = 60_000): void {
    setInterval(() => this.check(), intervalMs).unref();
  }
}
