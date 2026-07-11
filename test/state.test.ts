import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.js';

describe('StateStore', () => {
  it('startet leer, wenn Datei fehlt', () => {
    const s = new StateStore(join(mkdtempSync(join(tmpdir(), 'tb-')), 'state.json'));
    expect(s.getSessionId()).toBeUndefined();
  });
  it('persistiert und liest Session-ID', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'tb-')), 'state.json');
    new StateStore(p).setSessionId('abc-123');
    expect(new StateStore(p).getSessionId()).toBe('abc-123');
  });
  it('clearSession entfernt die ID', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'tb-')), 'state.json');
    const s = new StateStore(p);
    s.setSessionId('abc');
    s.clearSession();
    expect(new StateStore(p).getSessionId()).toBeUndefined();
  });
  it('überlebt kaputtes JSON', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'tb-')), 'state.json');
    writeFileSync(p, '{kaputt');
    expect(new StateStore(p).getSessionId()).toBeUndefined();
  });
  it('sammelt alle je gesetzten Session-IDs', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'tb-')), 'state.json');
    const s = new StateStore(p);
    s.setSessionId('a');
    s.setSessionId('b');
    s.setSessionId('a');
    s.clearSession();
    expect(new StateStore(p).getBridgeSessionIds()).toEqual(['a', 'b']);
  });
  it('migriert Alt-State: vorhandene sessionId landet in bridgeSessionIds', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'tb-')), 'state.json');
    writeFileSync(p, JSON.stringify({ sessionId: 'alt-123' }));
    expect(new StateStore(p).getBridgeSessionIds()).toEqual(['alt-123']);
  });
});
