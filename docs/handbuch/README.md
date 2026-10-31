# Anemo – Handbuch

Anemo ist das Testmanagement für Testfälle, Planung, Durchführung, Auswertung und Testnachweise. Es löst
Jira/Zephyr ab und verbindet sich mit OpenProject, GitLab, CI-Pipelines und KI-Agenten.

## Benutzerhandbuch
1. [Erste Schritte](01-erste-schritte.md): Anmeldung, Oberfläche, Suche, Rollen
2. [Testfälle](02-testfaelle.md): anlegen, bearbeiten, Abfragesprache, Massenbearbeitung, Ordner, Vorbedingungen,
   aufrufbare Tests, Schrittbibliothek, Freitext-Testfälle, Schätzung, Archivieren, Gherkin, Versionen, Workflow,
   Beobachten, Anhänge, Import/Export, Verweise
3. [Planung & Durchführung](03-planung-durchfuehrung.md): Testpläne, Zyklen, Konfigurationen, risikobasierte Auswahl,
   Ausführungssuche, Jetzt ausführen, Ausführen, Befunde, Fehler je Schritt, explorative Sitzungen, automatisierte
   Ergebnisse, CI-Pipeline starten, Excel-Rundlauf, Fehler melden mit Schweregrad, Nachtest, Nur Zuständige
4. [Auswertung & Berichte](04-auswertung-berichte.md): Cockpit mit Burn-down und Lagebild, Teststatusbericht
   (Zwischenbericht), Matrix, Top-Fehler, Team & Aufwand, Portfolio, Test-Health, Analysen, Testberichte (auch PDF),
   Lieferpaket
5. [Zusammenarbeit & Automatisierung](05-zusammenarbeit.md): Diskussion, OpenProject (Abdeckung ins Ticket,
   Verknüpfen per Nummer), Jira, GitLab, Benachrichtigungen, Beobachten, API, CI-Ergebnisse und CI-Pipeline aus Anemo,
   KI-Agenten

## Für Verantwortliche
- [Administrationshandbuch](10-administration.md): Benutzer, Gruppen, Rechte, sensible Projekte, Status &
  Workflow, Felder & Prioritäten, Konfigurationen, Berichtsprofile, Integrationen (OpenProject-Projektzuordnung,
  Fehler in Jira anlegen, Zweig für CI), Nur Zuständige, Migration
- [Betriebshandbuch](20-betrieb.md): Architektur, Installation, Konfigurationsreferenz, Sicherung, Aktualisierung,
  Überwachung, Sicherheit, Fehlerbehebung

## Vertiefung
Architekturentscheidungen: [docs/adr](../adr). Migration aus Jira/Zephyr: [Export](../migration/zephyr-export.md).
Einrichtung im Detail: [SSO/LDAP](../anmeldung-sso.md), [OpenProject](../openproject.md),
[CI-Ergebnisse](../automation.md), [MCP](../mcp.md), [KI-Agenten](../agenten.md), [KI-Assistenz](../ki-assistenz.md),
[Feldgrößen](../ui/feldgroessen.md).
