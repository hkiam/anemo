# Änderungen

## 0.9.3 – 19.11.2026
Verbesserungen aus dem Testbetrieb, keine Migration.

**Neu**
- Testfälle: Der Ordnerbaum ist auf- und zuklappbar (anfangs zugeklappt, „Alle auf/zu“, Tastatur wie im WAI-ARIA-Baum,
  Filter bei vielen Ordnern, Testfallzahl einschließlich Unterordnern). Die Breiten von Ordnerspalte, Testfallliste
  und Testfall lassen sich per Ziehgriff oder Tastatur einstellen und werden je Benutzer gespeichert; die Ordnerspalte
  lässt sich ausblenden. Auch die Navigation in Planung, Test-Health, Handbuch und die Ausführungsliste sind verstellbar.
- Zyklen per AQL oder Testset befüllen (`POST /api/cycles/:id/executions` mit `aql` bzw. `testSetId`, bis 5000
  Testfälle, Fehler statt stillem Abschneiden), auch über die MCP-Werkzeuge `create_cycle` und `add_tests_to_cycle`.
- Konten: SSO- bzw. LDAP-Konten lassen sich vorab anlegen (Rechte gelten ab der ersten Anmeldung) und vorhandene
  Konten zwischen lokaler Anmeldung und SSO/LDAP umstellen – Rechte, Gruppen, Historie und API-Tokens bleiben.
  Das eigene Konto und der letzte lokale Systemadministrator (Notzugang) sind ausgenommen.

**Korrekturen**
- Dynamische Testsets werten reine AQL, JSON-Objekte und die Kurzform `aql` aus und lehnen unauswertbare Filter ab,
  statt alle Testfälle zu liefern.
- MCP `api_call`: Bei DELETE wird der Body weitergereicht (Projekt löschen braucht `confirmKey`).
- Oberfläche nach einem Update: `index.html` wird nicht mehr zwischengespeichert (`Cache-Control: no-cache`), Bausteine
  unter `/assets/` gelten als unveränderlich, fehlende Bausteine liefern 404 statt der HTML-Seite – vorher konnte nach
  einem Update (z. B. beim Rücksprung von der SSO-Anmeldung) eine weiße Seite erscheinen.
- KI: Antworten, die an der Längengrenze abgeschnitten wurden (bei Reasoning-Modellen zählt die Denkphase mit), werden
  erkannt und einmal mit mehr Spielraum wiederholt. Kaputte oder leere Antworten, Zeitüberschreitung und Modellfehler
  ergeben eine verständliche Meldung (502) statt „Interner Fehler“.
- Mit Kennwort melden sich nur noch lokale Konten an.

## 0.9.2 – 10.11.2026
Korrekturen aus dem Testbetrieb, keine Migration.

**Korrekturen**
- Test-Health: Beim Wechsel zwischen den Analysen („Ähnliche Testfälle“, „Fehlerursachen“, „Anforderungsabdeckung“)
  stürzte die Ansicht sporadisch mit „Cannot read properties of undefined (reading 'length')“ ab – die neue Analyse
  zeichnete bis zur Antwort des Servers kurz die Daten der vorigen.
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
