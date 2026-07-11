import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class StateStore {
  private data: { sessionId?: string; bridgeSessionIds?: string[] } = {};
  constructor(private filePath: string) {
    if (existsSync(filePath)) {
      try {
        this.data = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        this.data = {};
      }
    }
    // Migration v1-State: sessionId existierte schon vor bridgeSessionIds
    if (this.data.sessionId && !this.data.bridgeSessionIds) {
      this.data.bridgeSessionIds = [this.data.sessionId];
    }
  }
  getSessionId(): string | undefined {
    return this.data.sessionId;
  }
  setSessionId(id: string): void {
    this.data.sessionId = id;
    const ids = (this.data.bridgeSessionIds ??= []);
    if (!ids.includes(id)) ids.push(id);
    this.save();
  }
  /** Alle Session-IDs, die die Bridge je erzeugt hat — Filter für /sessions. */
  getBridgeSessionIds(): string[] {
    return this.data.bridgeSessionIds ?? [];
  }
  clearSession(): void {
    delete this.data.sessionId;
    this.save();
  }
  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
