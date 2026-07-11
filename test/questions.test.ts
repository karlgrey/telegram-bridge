import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionStore } from '../src/questions.js';

const NOW = Date.parse('2026-07-11T12:00:00Z');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-q-'));
  return { file: join(dir, 'questions.json'), answers: join(dir, 'answers') };
}

describe('QuestionStore', () => {
  it('registriert Frage und schreibt Antwort-Datei bei Reply', () => {
    const { file, answers } = setup();
    const q = new QuestionStore(file, answers, NOW);
    q.register('frage-1', 42, NOW);
    expect(q.isOpenQuestion(42)).toBe(true);
    expect(q.answerByMessageId(42, 'Ja, mach so')).toBe('answered');
    expect(readFileSync(join(answers, 'frage-1.txt'), 'utf8')).toBe('Ja, mach so');
  });
  it('zweite Antwort auf dieselbe Frage → stale', () => {
    const { file, answers } = setup();
    const q = new QuestionStore(file, answers, NOW);
    q.register('frage-1', 42, NOW);
    q.answerByMessageId(42, 'erste');
    expect(q.answerByMessageId(42, 'zweite')).toBe('stale');
    expect(q.isOpenQuestion(42)).toBe(false);
  });
  it('Reply auf unbekannte Message → none', () => {
    const { file, answers } = setup();
    expect(new QuestionStore(file, answers, NOW).answerByMessageId(99, 'x')).toBe('none');
  });
  it('persistiert über Neustart und verwirft Records älter als 24 h', () => {
    const { file, answers } = setup();
    const q = new QuestionStore(file, answers, NOW);
    q.register('frisch', 1, NOW - 60_000);
    q.register('alt', 2, NOW - 25 * 60 * 60_000);
    const q2 = new QuestionStore(file, answers, NOW);
    expect(q2.isOpenQuestion(1)).toBe(true);
    expect(q2.answerByMessageId(2, 'x')).toBe('none');
  });
  it('überlebt kaputten State (valides JSON, aber kein Array)', () => {
    const { file, answers } = setup();
    writeFileSync(file, '{"nicht":"ein array"}');
    const q = new QuestionStore(file, answers, NOW);
    expect(q.answerByMessageId(1, 'x')).toBe('none');
  });
  it('openQuestions liefert nur unbeantwortete, nicht abgelaufene Fragen', () => {
    const { file, answers } = setup();
    const q = new QuestionStore(file, answers, NOW);
    q.register('frisch', 1, NOW, 30);
    q.register('abgelaufen', 2, NOW - 10 * 60_000, 5);
    q.register('beantwortet', 3, NOW, 30);
    q.answerByMessageId(3, 'x');
    expect(q.openQuestions(NOW).map((r) => r.questionId)).toEqual(['frisch']);
  });
  it('Alt-Records ohne expiresAt gelten 30 Min ab Erstellung', () => {
    const { file, answers } = setup();
    writeFileSync(
      file,
      JSON.stringify([
        { questionId: 'alt-jung', messageId: 1, createdAt: NOW - 10 * 60_000, answered: false },
        { questionId: 'alt-alt', messageId: 2, createdAt: NOW - 40 * 60_000, answered: false },
      ]),
    );
    const q = new QuestionStore(file, answers, NOW);
    expect(q.openQuestions(NOW).map((r) => r.questionId)).toEqual(['alt-jung']);
  });
  it('räumt beim Start Antwort-Dateien älter als 24 h auf', () => {
    const { file, answers } = setup();
    mkdirSync(answers, { recursive: true });
    const oldFile = join(answers, 'uralt.txt');
    writeFileSync(oldFile, 'x');
    utimesSync(oldFile, (NOW - 25 * 60 * 60_000) / 1000, (NOW - 25 * 60 * 60_000) / 1000);
    const freshFile = join(answers, 'frisch.txt');
    writeFileSync(freshFile, 'y');
    new QuestionStore(file, answers, NOW);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });
});
