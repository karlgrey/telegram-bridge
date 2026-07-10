import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, loadGateConfig } from '../src/gate.js';

// Testkonfigurationen liegen als echte Dateien vor (loadGateConfig liest von der
// Platte) — jeder Test bekommt sein eigenes Temp-Verzeichnis, damit nichts
// zwischen Fällen kollidiert.
const tmpDirs: string[] = [];
function writeConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'));
  tmpDirs.push(dir);
  const path = join(dir, 'gate.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const cfg = loadGateConfig(
  writeConfig({
    requireGo: [
      { tool: 'Bash', pattern: '--send' },
      { tool: 'Bash', pattern: 'api\\.resend\\.com' },
    ],
  }),
);

describe('classify', () => {
  it('lässt Lese-Tools durch', () => {
    expect(classify(cfg, 'Read', { file_path: '/tmp/x' })).toBe('allow');
  });
  it('lässt harmlose Bash-Kommandos durch', () => {
    expect(classify(cfg, 'Bash', { command: 'ls -la' })).toBe('allow');
  });
  it('fängt --send ab', () => {
    expect(classify(cfg, 'Bash', { command: 'python3 send-belege.py ordner --send' })).toBe('go');
  });
  it('fängt Resend-API-Aufrufe ab, case-insensitive', () => {
    expect(classify(cfg, 'Bash', { command: 'curl HTTPS://API.RESEND.COM/emails' })).toBe('go');
  });
  it('matcht Tool-Namen exakt (kein Substring)', () => {
    expect(classify(cfg, 'BashOutput', { command: 'x --send' })).toBe('allow');
  });
});

describe('loadGateConfig', () => {
  it('lädt eine gültige Konfiguration und kompiliert die Muster vor', () => {
    const path = writeConfig({
      requireGo: [{ tool: 'Bash', pattern: '--send' }],
    });
    const loaded = loadGateConfig(path);
    expect(loaded.requireGo).toHaveLength(1);
    expect(classify(loaded, 'Bash', { command: 'foo --send' })).toBe('go');
  });

  it('wirft bei ungültigem Regex-Muster mit Hinweis auf die Regel', () => {
    const path = writeConfig({
      requireGo: [{ tool: 'Bash', pattern: '(unclosed' }],
    });
    expect(() => loadGateConfig(path)).toThrow(/Regel #1/);
  });

  it('wirft bei fehlendem Feld ("pattern") mit Hinweis auf die Regel', () => {
    const path = writeConfig({
      requireGo: [{ tool: 'Bash' }],
    });
    expect(() => loadGateConfig(path)).toThrow(/Regel #1/);
  });

  it('wirft bei fehlendem Feld ("tool") mit Hinweis auf die Regel', () => {
    const path = writeConfig({
      requireGo: [{ pattern: '--send' }],
    });
    expect(() => loadGateConfig(path)).toThrow(/Regel #1/);
  });
});
