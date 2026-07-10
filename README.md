# Telegram-Bridge

Lokaler Daemon: Micha ↔ Telegram-Bot ↔ Claude-Code-Session (Agent SDK,
cwd = TheBrain2). Spec: TheBrain2 → docs/superpowers/specs/2026-07-10-telegram-bridge-design.md

## Leitplanken
- Whitelist-Default leer — ohne config/config.json antwortet der Bot niemandem.
- Go-Gate: außenwirksame Tool-Calls (config/gate.json) brauchen Ja-Button in Telegram (15-min-Timeout).
- data/ und .env bleiben lokal (gitignored). Chat-Inhalte gehen nie ins Wiki.

## Setup
1. Bot bei @BotFather anlegen → Token in `.env` (TELEGRAM_BOT_TOKEN).
2. `cp config/config.example.json config/config.json`, `cp config/gate.example.json config/gate.json`, `cp .env.example .env` und ausfüllen.
3. `npm run get-user-id` → dem Bot eine Nachricht schicken → gezeigte ID als allowedUserId eintragen.
4. `npm run dev` zum Testen; produktiv via launchd (launchd/README-Abschnitt unten).
