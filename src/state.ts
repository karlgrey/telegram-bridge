import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class StateStore {
  private data: { sessionId?: string } = {};
  constructor(private filePath: string) {
    if (existsSync(filePath)) {
      try {
        this.data = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        this.data = {};
      }
    }
  }
  getSessionId(): string | undefined {
    return this.data.sessionId;
  }
  setSessionId(id: string): void {
    this.data.sessionId = id;
    this.save();
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
