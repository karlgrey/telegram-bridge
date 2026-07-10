import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Context } from 'grammy';

// Pfade am Repo-Root verankern (nicht am process.cwd()), damit der Daemon
// unabhängig vom Startverzeichnis funktioniert.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const INBOX = join(MODULE_DIR, '..', 'data', 'inbox');
const OUTBOX = join(MODULE_DIR, '..', 'data', 'outbox');

/**
 * Von Telegram gelieferte Dateinamen auf einen sicheren Basisnamen reduzieren
 * (kein Path-Traversal, keine Sonderzeichen außerhalb des Whitelist-Sets).
 */
export function safeName(name: string): string {
  const base = basename(name);
  const cleaned = base.replace(/[^A-Za-z0-9._äöüÄÖÜß-]/g, '_');
  const isEmptyOrOnlyDots = cleaned.length === 0 || /^\.+$/.test(cleaned);
  return isEmptyOrOnlyDots ? 'datei' : cleaned;
}

/** Foto/Dokument der Nachricht nach data/inbox/<datum>/ laden. */
export async function saveIncoming(ctx: Context, token: string): Promise<string | undefined> {
  const doc = ctx.message?.document;
  const photo = ctx.message?.photo?.at(-1); // größte Auflösung
  const fileId = doc?.file_id ?? photo?.file_id;
  if (!fileId) return undefined;
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) return undefined;
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(INBOX, day);
  mkdirSync(dir, { recursive: true });
  const name = safeName(doc?.file_name ?? `photo-${Date.now()}.jpg`);
  const target = join(dir, `${Date.now()}-${name}`);
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok || !res.body) throw new Error(`Telegram-Download fehlgeschlagen: ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target));
  } catch (err) {
    // Best effort: unvollständig geschriebene Datei nicht liegen lassen.
    await unlink(target).catch(() => {});
    throw err;
  }
  return target;
}

/** Alle Dateien aus data/outbox/ senden und nach sent/ verschieben. */
export async function flushOutbox(sendFile: (path: string) => Promise<void>): Promise<number> {
  if (!existsSync(OUTBOX)) return 0;
  const sentDir = join(OUTBOX, 'sent');
  mkdirSync(sentDir, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(OUTBOX)) {
    const full = join(OUTBOX, entry);
    if (!statSync(full).isFile()) continue;
    await sendFile(full);
    renameSync(full, join(sentDir, `${Date.now()}-${entry}`));
    count++;
  }
  return count;
}
