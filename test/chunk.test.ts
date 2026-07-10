import { describe, it, expect } from 'vitest';
import { chunkMessage } from '../src/chunk.js';

describe('chunkMessage', () => {
  it('lässt kurze Texte unangetastet', () => {
    expect(chunkMessage('hallo')).toEqual(['hallo']);
  });
  it('liefert [] für leeren Text', () => {
    expect(chunkMessage('')).toEqual([]);
  });
  it('splittet bevorzugt an Absatzgrenzen', () => {
    const a = 'x'.repeat(60);
    const b = 'y'.repeat(60);
    const chunks = chunkMessage(`${a}\n\n${b}`, 100);
    expect(chunks).toEqual([a, b]);
  });
  it('hält das Limit auch ohne Grenzen ein', () => {
    const chunks = chunkMessage('z'.repeat(250), 100);
    expect(chunks.length).toBe(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(100);
    expect(chunks.join('')).toBe('z'.repeat(250));
  });
});
