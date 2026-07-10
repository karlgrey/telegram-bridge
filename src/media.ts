import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Context } from 'grammy';

const INBOX = resolve('data/inbox');
const OUTBOX = resolve('data/outbox');

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
  const name = doc?.file_name ?? `photo-${Date.now()}.jpg`;
  const target = join(dir, `${Date.now()}-${name}`);
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok || !res.body) throw new Error(`Telegram-Download fehlgeschlagen: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target));
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
