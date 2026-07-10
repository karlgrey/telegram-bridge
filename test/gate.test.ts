import { describe, it, expect } from 'vitest';
import { classify, type GateConfig } from '../src/gate.js';

const cfg: GateConfig = {
  requireGo: [
    { tool: 'Bash', pattern: '--send' },
    { tool: 'Bash', pattern: 'api\\.resend\\.com' },
  ],
};

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
