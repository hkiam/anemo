# ADR-0025: Einstellungen in der Oberfläche, Umgebungsvariablen als Vorbelegung

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Integrationen (GitLab, OpenProject, Jira, Mail), Anmeldeverfahren (OIDC, LDAP) und das KI-Modell waren nur über
Umgebungsvariablen einstellbar. Für den Betrieb im Container ist das richtig (Vorkonfiguration von außen,
reproduzierbar). Administratoren sollen Werte aber auch ohne Neustart und ohne Zugriff auf den Server ändern
können. Geheimnisse dürfen dabei nicht im Klartext in der Datenbank liegen.

## Entscheidung
- Für jede einstellbare Variable gibt es einen Eintrag in der Registrierung (`platform/settings.ts`): Gruppe,
  Beschriftung, Typ, Standard und Hinweis. Infrastrukturwerte wie `DATABASE_URL`, `ANEMO_AUTH`, Port und
  Pfade sind bewusst nicht dabei.
- **Rangfolge:** Oberfläche → Umgebung → Standard. Ein leerer Wert in der Oberfläche schaltet einen
  Umgebungswert ab, „Zurücksetzen“ entfernt den Oberflächenwert. Alle Konfigurationsfunktionen lesen über
  `settingsEnv()`, Änderungen wirken sofort.
- **Geheimnisse** (Passwörter, Tokens, API-Schlüssel) werden mit AES-256-GCM verschlüsselt. Der Schlüssel
  stammt aus `ANEMO_SECRET_KEY` oder aus `secret.key` im Datenverzeichnis (0600, beim ersten Bedarf erzeugt,
  Teil der Sicherung). Die API gibt Geheimnisse nie zurück, nur „gesetzt“.
- Änderungen werden ohne Werte protokolliert: wer, wann, welcher Schlüssel, festgelegt bzw. zurückgesetzt.
- KI: Hauptschalter `AI_ENABLED`, Agentenschalter `AGENTS_ENABLED`, Kontingent `AI_MAX_REQUESTS_PER_HOUR`,
  Nutzungsprotokoll ohne Inhalte, anpassbare Prompts je Funktion (`ai_prompt`, Standard wiederherstellbar).

## Konsequenzen
Container lassen sich weiterhin vollständig über `.env` vorbelegen. Die Oberfläche zeigt je Wert dessen Herkunft.
Geht `secret.key` verloren, sind die dort gespeicherten Geheimnisse nicht mehr lesbar: Die Oberfläche markiert
sie, sie werden neu eingegeben, und die Umgebung gilt weiter.
