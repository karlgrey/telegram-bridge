# Telegram-Bridge

Lokaler Daemon: Micha ↔ Telegram-Bot ↔ Claude-Code-Session (Agent SDK,
cwd = TheBrain2). Spec: TheBrain2 → docs/superpowers/specs/2026-07-10-telegram-bridge-design.md

## Leitplanken
- Whitelist-Default leer — ohne config/config.json antwortet der Bot niemandem.
- Go-Gate: außenwirksame Tool-Calls (config/gate.json) brauchen Ja-Button in Telegram (15-min-Timeout).
- data/ und .env bleiben lokal (gitignored). Chat-Inhalte gehen nie ins Wiki.

## Grenzen des Go-Gates

Das Go-Gate (`config/gate.json`, geprüft in `canUseTool`) fängt zuverlässig nur
Bash-artige Tool-Calls ab. Zwei bekannte blinde Flecken (Details im Kommentar
bei `permissionMode`/`settingSources` in `src/agent.ts`):

- **`permissionMode: 'acceptEdits'`** genehmigt datei-editierende Tools
  (Write/Edit/…) automatisch auf SDK-Ebene — `canUseTool` feuert dafür gar
  nicht erst, das Gate sieht diese Calls also nie.
- **`settingSources: ['user', 'project']`** zieht Allow-Regeln aus Michas
  bzw. dem Projekt-Settings (z. B. `.claude/settings.json`) — dort erlaubte
  Tools umgehen den `canUseTool`-Hook ebenfalls.

Gate-Muster in `config/gate.json` sind also kein vollständiger Schutz gegen
alle möglichen Tool-Calls, sondern gezielt gegen außenwirksame Bash-Aktionen
(Mail-Versand, `curl` gegen fremde APIs, `git push`, …).

## Session-Sicht & Rückfrage-Kanal (v1.2)

- **/sessions** — listet Laptop-Sessions der letzten 24 h (Transkript-Ordner
  `~/.claude/projects/-Users-mca-Development-TheBrain2/`), Bridge-eigene
  Sessions werden über `data/state.json` (`bridgeSessionIds`) gefiltert.
  🟢 = Transkript <10 Min alt UND ein `claude`-Prozess läuft.
- **Rückfrage-Kanal** — `POST /notify {"text", "question_id"}` schickt die
  Frage mit Reply-Aufforderung; Michas Telegram-Reply wird nach
  `data/answers/<question_id>.txt` geschrieben. Absender-Skript:
  `~/Development/TheBrain2/tools/frage-micha.sh` (pollt die Antwort-Datei,
  Session arbeitet im selben Turn weiter). Frage-Records: `data/questions.json`
  (24-h-Aufräumen beim Start).
- Der Daemon setzt `TELEGRAM_BRIDGE=1`; der Notification-Hook im
  TheBrain2-Repo schweigt dann (sonst doppelte Meldung neben dem Go-Gate).

## Setup
1. Bot bei @BotFather anlegen → Token in `.env` (TELEGRAM_BOT_TOKEN).
2. `cp config/config.example.json config/config.json`, `cp config/gate.example.json config/gate.json`, `cp .env.example .env` und ausfüllen.
3. `npm run get-user-id` → dem Bot eine Nachricht schicken → gezeigte ID als allowedUserId eintragen.
4. `npm run dev` zum Testen; produktiv via launchd (launchd/README-Abschnitt unten).
