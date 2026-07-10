import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function startHeartbeat(filePath: string, intervalMs = 60_000): void {
  const beat = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ connected: true, detail: 'polling', updatedAt: new Date().toISOString() }, null, 2),
    );
  };
  beat();
  setInterval(beat, intervalMs).unref();
}
