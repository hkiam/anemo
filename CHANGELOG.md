# Änderungen

## Unveröffentlicht

**Korrekturen**
- MCP: `/.well-known/*` antwortet mit 404 (JSON) statt mit der Weboberfläche. MCP-Clients mit OAuth-Erkennung wie
  `mcp-remote` (Claude Desktop) scheitern bei falschem oder abgelaufenem Token damit nachvollziehbar an der
  OAuth-Erkennung statt an „Unexpected token '<'“; die Fehlersuche in `docs/mcp.md` nennt die Meldungen.

**Dokumentation**
- MCP-Einrichtung für Claude Desktop mit `mcp-remote` 0.15.2 getestet; Hinweise zu `--allow-http` und zu den Logs.

## 0.9.1 – 30.10.2026
Behebt alle Befunde des Reviews vom 30.10.2026 (Sicherheit, Korrektheit, Fachlichkeit) sowie Darstellungsfehler mit
Realdaten. Migration 040, Paketformat der Projektübertragung 1.3.

**Sicherheit**
- Projektübertragung: Ein Import verändert und liest keine Testfälle anderer bzw. nicht lesbarer Projekte mehr.
  Anbindungen, Webhooks, Freigaben und Prüfvermerke aus Paketen übernimmt nur die Systemadministration.
  Webhook-Adressen werden nur als Host exportiert.
- MCP (`api_call`): keine API-Tokens und keine Kennwörter anderer Konten; Bestätigung für Administration, Einspielen,
  Mitglieder, Anbindungen und Freigabeentscheidung.
- Adressen fremder Anbieter an Verweisen werden geprüft (Domainliste); reservierte KI-Anfrageparameter gesperrt.
- zod 4.6.7 (GHSA-mrhx-c7xc-m3w5).

**Revisionssicherheit (ADR-0028)**
- Freigabestand: Zu jeder Freigabeentscheidung wird das Lieferpaket abgelegt (SHA-256 im Protokoll); Änderungen nach
  der Entscheidung zeigen Cockpit und Abschlussbericht.
- Protokoll je Projekt und Instanz mit Filtern, deutschen Bezeichnungen und CSV; alte und neue Werte bei Kriterien,
  Plänen, Zyklen, Zyklusstatus, Projektregeln, Statuskatalog und Fazit; Ereignisse unveränderlich.
- Fazit mit Verfasser, Zeitpunkt und KI-Vermerk.

**Fachlich**
- Nachtest nur in gleicher Konfiguration; sonst protokolliert und als „behoben, aber nicht nachgetestet“ ausgewiesen;
  Ergebnis des Nachtests als Kommentar am OpenProject-Ticket.
- Ungeprüfte Ergebnisse von KI-Agenten ersetzt nur die Testleitung.
- Neuer Ergebnisstatus „Nicht anwendbar“; Testart pflegbar; Testpläne archivierbar.
- PDF-Berichte getaggt (PDF/UA-orientiert), mit eingebetteter Schrift (DejaVu) und PDF/A-2b-Merkmalen.
- Einheitliche Begriffe und Rollen im Handbuch (Glossar).

**Korrektheit**
- Import in bestehende Projekte: „überspringen“ ohne neue Versionen, Wiederholungen getrennt, abgeschlossene Zyklen
  unberührt, Anhänge erst nach dem Commit, Probelauf ohne Sperre.
- Umstellen auf die aktuelle Testfallversion sperrt die Ausführung und öffnet betroffene Durchläufe.
- „Fehlgeschlagen (bekannt)“ zählt in Abdeckung und Risiko als nicht in Ordnung.
- Wiederholungsversuche im CI-Import nur bei kurz zurückliegendem Fehlschlag.

**Oberfläche**
- Listen und Tabellen nutzen breite Fenster; nichts wird mehr abgeschnitten (auch mit Realdaten); Layoutprüfung
  meldet seitlich scrollende Tabellen.
- KI on-prem: Denkphase von Reasoning-Modellen (Qwen3) wird entfernt, zusätzliche Anfrageparameter je Profil.

## 0.9.0 – 19.10.2026
Erste nummerierte Version (Stufen A–I, J).
