import { readFileSync } from 'node:fs';

export type GateRule = { tool: string; pattern: string };
export type GateConfig = { requireGo: GateRule[] };

export function loadGateConfig(path: string): GateConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { requireGo: raw.requireGo ?? [] };
}

/** Klassifiziert einen Tool-Call: 'go' = braucht Michas Ja-Button. */
export function classify(cfg: GateConfig, toolName: string, input: unknown): 'allow' | 'go' {
  const serialized = JSON.stringify(input ?? {});
  for (const rule of cfg.requireGo) {
    if (rule.tool !== toolName) continue;
    if (new RegExp(rule.pattern, 'i').test(serialized)) return 'go';
  }
  return 'allow';
}
