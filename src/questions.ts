import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type QuestionRecord = { questionId: string; messageId: number; createdAt: number; answered: boolean };

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Offene Rückfragen von Laptop-Sessions: Message-ID des Telegram-Pushs → Antwort-Datei. */
export class QuestionStore {
  private data: QuestionRecord[] = [];
  constructor(
    private filePath: string,
    private answersDir: string,
    now = Date.now(),
  ) {
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        this.data = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.data = [];
      }
    }
    this.data = this.data.filter((q) => now - q.createdAt < MAX_AGE_MS);
    this.save();
    this.cleanupAnswers(now);
  }
  register(questionId: string, messageId: number, now = Date.now()): void {
    this.data.push({ questionId, messageId, createdAt: now, answered: false });
    this.save();
  }
  isOpenQuestion(messageId: number): boolean {
    return this.data.some((q) => q.messageId === messageId && !q.answered);
  }
  answerByMessageId(messageId: number, text: string): 'answered' | 'stale' | 'none' {
    const q = this.data.find((r) => r.messageId === messageId);
    if (!q) return 'none';
    if (q.answered) return 'stale';
    q.answered = true;
    mkdirSync(this.answersDir, { recursive: true });
    // Absichtlich Datei VOR save(): Crash dazwischen kostet schlimmstenfalls eine
    // Doppel-Antwort in dieselbe Datei — umgekehrt wäre Michas Antwort verloren.
    writeFileSync(join(this.answersDir, `${q.questionId}.txt`), text);
    this.save();
    return 'answered';
  }
  private cleanupAnswers(now: number): void {
    if (!existsSync(this.answersDir)) return;
    for (const f of readdirSync(this.answersDir)) {
      const p = join(this.answersDir, f);
      try {
        if (now - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p);
      } catch {
        // Wettlauf mit lesendem Skript — egal, nächster Start räumt nach
      }
    }
  }
  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
