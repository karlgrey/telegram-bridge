import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { execSync } from 'node:child_process';

export type SessionInfo = {
  id: string;
  topic: string; // erste echte Nutzer-Nachricht, gekürzt
  lastActivity: number; // Datei-mtime in ms
  startedAt?: number; // Timestamp der ersten Nutzer-Zeile in ms
};

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** Erste echte Nutzer-Nachricht (kein Sidechain, kein tool_result, kein System-Reminder). */
async function readTopic(filePath: string): Promise<{ topic: string; startedAt?: number }> {
  const rl = createInterface({ input: createReadStream(filePath, 'utf8') });
  try {
    for await (const line of rl) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== 'user' || entry.isSidechain) continue;
      const message = entry.message as { content?: unknown } | undefined;
      const content = message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter(
                  (c): c is { type: string; text: string } =>
                    typeof c === 'object' &&
                    c !== null &&
                    (c as { type?: unknown }).type === 'text' &&
                    typeof (c as { text?: unknown }).text === 'string',
                )
                .map((c) => c.text)
                .join(' ')
            : '';
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean || clean.startsWith('<')) continue;
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined;
      return { topic: clean.slice(0, 100), startedAt: Number.isNaN(ts) ? undefined : ts };
    }
  } finally {
    rl.close();
  }
  return { topic: '(kein Thema erkennbar)' };
}

/** Laptop-Sessions der letzten 24 h aus dem Claude-Code-Transkript-Ordner. */
export async function listSessions(opts: {
  projectDir: string;
  excludeIds: string[];
  now?: number;
}): Promise<SessionInfo[]> {
  const now = opts.now ?? Date.now();
  let files: string[];
  try {
    files = readdirSync(opts.projectDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const excluded = new Set(opts.excludeIds);
  const result: SessionInfo[] = [];
  for (const f of files) {
    const id = basename(f, '.jsonl');
    if (excluded.has(id)) continue;
    let mtime: number;
    try {
      mtime = statSync(join(opts.projectDir, f)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > MAX_AGE_MS) continue;
    const { topic, startedAt } = await readTopic(join(opts.projectDir, f));
    result.push({ id, topic, lastActivity: mtime, startedAt });
  }
  return result.sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Grobe Prüfung, ob irgendein interaktiver claude-CLI-Prozess läuft. */
export function claudeProcessRunning(): boolean {
  try {
    const out = execSync('ps -axo command=', { encoding: 'utf8' });
    return out.split('\n').some((l) => /(^|\/)claude(\s|$)/.test(l.trim()));
  } catch {
    return false;
  }
}

export function formatSessions(sessions: SessionInfo[], claudeRunning: boolean, now = Date.now()): string {
  if (sessions.length === 0) return 'Keine Laptop-Sessions in den letzten 24 h gefunden.';
  const lines = sessions.map((s) => {
    const mins = Math.round((now - s.lastActivity) / 60_000);
    const active = claudeRunning && now - s.lastActivity < ACTIVE_WINDOW_MS;
    const start = s.startedAt
      ? new Date(s.startedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      : '?';
    return `${active ? '🟢' : '⚪'} ${start} — ${s.topic} · zuletzt vor ${mins} Min`;
  });
  return `${sessions.length} Session(s) (letzte 24 h):\n${lines.join('\n')}`;
}
