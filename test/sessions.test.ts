import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions, formatSessions } from '../src/sessions.js';

const NOW = Date.parse('2026-07-11T12:00:00Z');

/** Legt ein Fixture-Transkript an und setzt seine mtime. */
function fixture(dir: string, id: string, lines: object[], mtimeMs: number): void {
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

const userLine = (text: string, ts = '2026-07-11T08:00:00.000Z') => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: text },
});

describe('listSessions', () => {
  it('liest Thema aus erster echter Nutzer-Nachricht, sortiert nach Aktivität', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-sess-'));
    fixture(dir, 'aaa', [{ type: 'mode', mode: 'normal' }, userLine('Standup und Belege bitte')], NOW - 5 * 60_000);
    fixture(dir, 'bbb', [userLine('Webflow Farmhouse-Seite bauen')], NOW - 60 * 60_000);
    const result = await listSessions({ projectDir: dir, excludeIds: [], now: NOW });
    expect(result.map((s) => s.id)).toEqual(['aaa', 'bbb']);
    expect(result[0].topic).toBe('Standup und Belege bitte');
    expect(result[0].startedAt).toBe(Date.parse('2026-07-11T08:00:00.000Z'));
  });
  it('filtert Bridge-Sessions und Sessions älter als 24 h', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-sess-'));
    fixture(dir, 'bridge1', [userLine('via Telegram')], NOW - 60_000);
    fixture(dir, 'alt', [userLine('alte Session')], NOW - 25 * 60 * 60_000);
    fixture(dir, 'laptop', [userLine('aktuelle Arbeit')], NOW - 60_000);
    const result = await listSessions({ projectDir: dir, excludeIds: ['bridge1'], now: NOW });
    expect(result.map((s) => s.id)).toEqual(['laptop']);
  });
  it('überspringt Sidechains, Tool-Results und System-Reminder-Zeilen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-sess-'));
    fixture(
      dir,
      'ccc',
      [
        { type: 'user', isSidechain: true, message: { content: 'Subagent-Prompt' } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
        { type: 'user', message: { content: '<system-reminder>bla</system-reminder>' } },
        { type: 'user', message: { content: [{ type: 'text', text: 'echtes Anliegen' }] } },
      ],
      NOW - 60_000,
    );
    const result = await listSessions({ projectDir: dir, excludeIds: [], now: NOW });
    expect(result[0].topic).toBe('echtes Anliegen');
  });
  it('leerer/fehlender Ordner → leere Liste', async () => {
    expect(await listSessions({ projectDir: '/nix/da', excludeIds: [], now: NOW })).toEqual([]);
  });
  it('wirft nicht bei null-Elementen im content-Array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-sess-'));
    fixture(
      dir,
      'ddd',
      [
        { type: 'user', message: { content: [null, { type: 'text', text: 'trotzdem lesbar' }] } },
      ],
      NOW - 60_000,
    );
    const result = await listSessions({ projectDir: dir, excludeIds: [], now: NOW });
    expect(result[0].topic).toBe('trotzdem lesbar');
  });
});

describe('formatSessions', () => {
  it('markiert frische Sessions 🟢 nur wenn claude läuft, sonst ⚪', () => {
    const sessions = [
      { id: 'a', topic: 'Standup', lastActivity: NOW - 2 * 60_000, startedAt: NOW - 3 * 60 * 60_000 },
      { id: 'b', topic: 'Webflow', lastActivity: NOW - 25 * 60_000, startedAt: undefined },
    ];
    const out = formatSessions(sessions, true, NOW);
    expect(out).toContain('🟢');
    expect(out).toContain('Standup');
    expect(out).toContain('⚪');
    expect(out).toContain('vor 25 Min');
    expect(formatSessions(sessions, false, NOW)).not.toContain('🟢');
  });
  it('leere Liste → klare Meldung', () => {
    expect(formatSessions([], true, NOW)).toContain('Keine Laptop-Sessions');
  });
});
