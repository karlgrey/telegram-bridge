import { describe, it, expect, vi } from 'vitest';
import { PollWatchdog } from '../src/watchdog.js';
import { log, logError } from '../src/log.js';

const T0 = Date.parse('2026-07-15T12:00:00Z');
const MIN = 60_000;

describe('PollWatchdog', () => {
  const setup = () => {
    const dead: number[] = [];
    const wd = new PollWatchdog(10 * MIN, (silenceMs) => void dead.push(silenceMs), T0);
    return { wd, dead };
  };

  it('frisch gestartet: nicht tot (Startzeit zählt als letzter Erfolg)', () => {
    const { wd, dead } = setup();
    expect(wd.check(T0 + 9 * MIN)).toBe(false);
    expect(dead).toEqual([]);
  });

  it('Stille ist NORMAL: 11 min ohne Update, aber getUpdates erfolgreich → nicht tot', () => {
    const { wd, dead } = setup();
    // getUpdates läuft im 30-s-Long-Poll erfolgreich durch (leere Update-Listen)
    wd.recordSuccess(T0 + 10 * MIN + 30_000);
    expect(wd.check(T0 + 11 * MIN)).toBe(false);
    expect(dead).toEqual([]);
  });

  it('kein Erfolg > 10 min UND letzter Versuch fehlgeschlagen → tot', () => {
    const { wd, dead } = setup();
    wd.recordSuccess(T0 + MIN);
    wd.recordFailure(T0 + 2 * MIN);
    wd.recordFailure(T0 + 8 * MIN);
    expect(wd.check(T0 + 12 * MIN)).toBe(true);
    expect(dead).toEqual([11 * MIN]);
  });

  it('Fehler, danach wieder Erfolg → nicht tot (Netz-Delle überstanden)', () => {
    const { wd } = setup();
    wd.recordFailure(T0 + MIN);
    wd.recordSuccess(T0 + 2 * MIN);
    expect(wd.check(T0 + 20 * MIN)).toBe(false); // kein Fehler seit letztem Erfolg
  });

  it('lange kein Erfolg, aber auch kein Fehlversuch (hängend, noch unentschieden) → nicht tot', () => {
    const { wd } = setup();
    wd.recordSuccess(T0 + MIN);
    // danach weder Erfolg noch Fehler registriert — kein False-Positive-Exit;
    // ein hängender getUpdates läuft in grammYs Client-Timeout und wird DANN zum Fehler
    expect(wd.check(T0 + 15 * MIN)).toBe(false);
  });
});

describe('log-Helper', () => {
  it('prefixt console.log/error mit ISO-Timestamp', () => {
    const outSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log('hallo', 42);
    logError('kaputt');
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(outSpy).toHaveBeenCalledOnce();
    expect(String(outSpy.mock.calls[0][0])).toMatch(iso);
    expect(outSpy.mock.calls[0].slice(1)).toEqual(['hallo', 42]);
    expect(String(errSpy.mock.calls[0][0])).toMatch(iso);
    expect(errSpy.mock.calls[0].slice(1)).toEqual(['kaputt']);
    outSpy.mockRestore();
    errSpy.mockRestore();
  });
});
