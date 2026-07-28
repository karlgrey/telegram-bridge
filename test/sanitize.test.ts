import { describe, it, expect } from 'vitest';
import { sanitizeText } from '../src/sanitize.js';

describe('sanitizeText', () => {
  it('ersetzt ein einzelnes Low-Surrogate ohne vorangehendes High durch U+FFFD', () => {
    expect(sanitizeText('\udcbb')).toBe('�');
  });

  it('ersetzt ein einzelnes High-Surrogate ohne folgendes Low durch U+FFFD', () => {
    expect(sanitizeText('\ud83d')).toBe('�');
  });

  it('lässt ein gültiges Surrogate-Paar (Emoji) unangetastet', () => {
    expect(sanitizeText('😀')).toBe('😀');
  });

  it('bereinigt lone surrogates in gemischtem Text, gültige Paare bleiben erhalten', () => {
    expect(sanitizeText('a\udcbbb😀c')).toBe('a�b😀c');
  });

  it('liefert für leeren String wieder einen leeren String', () => {
    expect(sanitizeText('')).toBe('');
  });
});
