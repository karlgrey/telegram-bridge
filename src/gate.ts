import { readFileSync } from 'node:fs';

export type GateRule = { tool: string; pattern: string };
// Intern hält jede Regel zusätzlich ihren vorkompilierten Regex — das Kompilieren
// passiert einmalig beim Laden (Startup), nicht bei jedem classify()-Aufruf mitten
// im Turn (sonst würde ein kaputtes Muster erst mitten in der Session auffallen).
type CompiledGateRule = GateRule & { regex: RegExp };
export type GateConfig = { requireGo: CompiledGateRule[] };

/**
 * Lädt und validiert die Gate-Konfiguration. Bricht beim Start hart ab
 * (nie mitten im Turn), wenn eine Regel fehlerhaft ist — mit klarer
 * Fehlermeldung, welche Regel betroffen ist.
 */
export function loadGateConfig(path: string): GateConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const rawRules = raw.requireGo ?? [];
  if (!Array.isArray(rawRules)) {
    throw new Error(`Ungültige Gate-Konfiguration (${path}): "requireGo" muss ein Array sein.`);
  }
  const requireGo: CompiledGateRule[] = rawRules.map((rule: unknown, index: number) => {
    const label = `Regel #${index + 1} in ${path}`;
    if (typeof rule !== 'object' || rule === null) {
      throw new Error(`Ungültige Gate-Konfiguration: ${label} ist kein Objekt.`);
    }
    const { tool, pattern } = rule as Record<string, unknown>;
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw new Error(`Ungültige Gate-Konfiguration: ${label} hat kein gültiges Feld "tool".`);
    }
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error(`Ungültige Gate-Konfiguration: ${label} (tool="${tool}") hat kein gültiges Feld "pattern".`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error(
        `Ungültige Gate-Konfiguration: ${label} (tool="${tool}") hat ein ungültiges Regex-Muster "${pattern}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { tool, pattern, regex };
  });
  return { requireGo };
}

/** Klassifiziert einen Tool-Call: 'go' = braucht Michas Ja-Button. */
export function classify(cfg: GateConfig, toolName: string, input: unknown): 'allow' | 'go' {
  const serialized = JSON.stringify(input ?? {});
  for (const rule of cfg.requireGo) {
    if (rule.tool !== toolName) continue;
    if (rule.regex.test(serialized)) return 'go';
  }
  return 'allow';
}
