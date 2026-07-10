import { describe, it, expect } from 'vitest';
import { safeName } from '../src/media.js';

describe('safeName', () => {
  it('reduziert Path-Traversal auf den Basisnamen', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
  });

  it('entfernt Slashes und Backslashes', () => {
    // basename() trennt nur an "/" (posix); ein verbliebener Backslash im
    // Rest-Namen wird von der Zeichen-Whitelist ersetzt.
    expect(safeName('a/b\\c.txt')).toBe('b_c.txt');
  });

  it('behält Umlaute', () => {
    expect(safeName('Rechnung Übersicht März.pdf')).toBe('Rechnung_Übersicht_März.pdf');
  });

  it('fällt bei leerem Namen auf "datei" zurück', () => {
    expect(safeName('')).toBe('datei');
  });

  it('fällt bei reinen Punkten (z. B. "..") auf "datei" zurück', () => {
    expect(safeName('..')).toBe('datei');
  });
});
