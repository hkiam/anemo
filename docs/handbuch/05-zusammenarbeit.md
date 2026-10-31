# Zusammenarbeit & Automatisierung

## Diskussion am Testfall
Jeder Testfall (und jede wiederverwendbare Vorbedingung) hat unten den Abschnitt **Diskussion**, z. B. für
Review-Anmerkungen. Schreiben darf jede Person mit Lesezugriff.
- **Anmerken**: Die Anmerkung bezieht sich auf die gerade angezeigte Version („zu v3“).
- **Antworten** führt einen Gesprächsfaden; eigene Anmerkungen lassen sich bearbeiten (✎) und löschen (✕).
- **@name** (Benutzername) erwähnt eine Person. Sie erhält eine E-Mail mit Auszug und Link, wenn sie unter
  *Benachrichtigungen* „Ich werde in einer Diskussion erwähnt (@name)“ gewählt hat. Bei Projekten mit gesperrten
  externen Diensten enthält die Mail nur einen Hinweis.
- **✓ erledigt** markiert eine Anmerkung als abgearbeitet („erledigt von …“), **wieder öffnen** macht das rückgängig.
  Erledigen dürfen die Autorin bzw. der Autor und Personen mit Rolle *Pflegen*. Erledigte sind ausgeblendet („n
  erledigte zeigen“).
- Offene Anmerkungen zeigt der Kopf des Testfalls als **💬 n**; ein Klick springt zur Diskussion.

## OpenProject
- **Verknüpfen**: Testfall, Zyklus oder Testplan → 🔗 Verknüpfen… → OpenProject → Arbeitspaket suchen. Das
  Arbeitspaket erhält einen Kommentar mit Link zurück nach Anemo.
- **Verknüpfen per Nummer**: Ist das Anemo-Projekt keinem OpenProject-Projekt zugeordnet, steht im
  Verknüpfen-Dialog „OpenProject (per Nummer)“. Die Nummer des Arbeitspakets eingeben (z. B. `1234`); Anemo zeigt Titel,
  Typ und Status, **Verknüpfen** übernimmt es. Die Suche bleibt zugeordneten Projekten vorbehalten; der Hinweis
  „OpenProject-Suche nicht verfügbar“ nennt den Grund (Systemadministratoren mit Link „Projekt jetzt zuordnen →“).
- **Fehler melden** aus der Durchführung legt ein Arbeitspaket mit vollständiger Beschreibung und Schweregrad an
  (Typ laut Projektzuordnung, sonst der Standardtyp), siehe [Planung & Durchführung](03-planung-durchfuehrung.md#fehler-melden-und-nachtest).
- **Status** wird alle 15 Minuten abgeglichen. Erledigte Fehler lösen einen **Nachtest** aus.
- **Abdeckung ins Ticket** (je Projekt in der Administration einschaltbar): Bei jedem Abgleich prüft Anemo den
  Teststand der verknüpften Anforderungen, Stories und Epics und schreibt nur bei einer **Änderung** einen Kommentar
  ans Arbeitspaket, z. B. „Testabdeckung (Anemo, DEMO): ✅ bestanden“ mit den Testfällen und ihrem letzten Ergebnis
  sowie einem Link nach Anemo. Stände: *❌ Fehler* (ein Testfall fehlgeschlagen oder blockiert), *✅ bestanden*
  (alle bestanden), *◐ teilweise getestet*, *⚪ noch nicht getestet*. Archivierte Testfälle zählen nicht.

## Jira (Parallelbetrieb)
Verknüpfte Jira-Tickets (aus der Migration und neue) zeigen ihren aktuellen Status. Er wird alle 6 Stunden
aktualisiert. Erledigte Jira-Fehler lösen ebenfalls einen Nachtest aus. In Jira schreibt Anemo nur, wenn die
Administration **Fehler in Jira anlegen** eingeschaltet und das Projekt einem Jira-Projekt zugeordnet hat; dann
entstehen neue Fehler dort (Vorgangstyp und Priorität je Schweregrad laut Zuordnung). Ist das Projekt auch einem
OpenProject-Projekt zugeordnet, hat OpenProject Vorrang.

## GitLab
- **⎇ Git** in den Testfällen: Gherkin ↔ `.feature`-Dateien, siehe [Testfälle](02-testfaelle.md).
- Merge-Requests und Commits verknüpfen (🔗 Verknüpfen… → GitLab). Der MR-Status (offen/gemergt) wird
  abgeglichen.

## Benachrichtigungen
Kontomenü → **Benachrichtigungen**: E-Mail-Adresse und Anlässe wählen (Ausführung zugewiesen, Nachtest fällig,
Fehlschlag in meinen Zyklen, Erwähnung in einer Diskussion, „Änderungen an Testfällen, Zyklen und Testplänen, die ich
beobachte (👁)“). Mehrere Ereignisse kommen gesammelt in einer Mail, eigene Aktionen lösen keine Mail
aus. Teams/Mattermost/Slack-Kanäle richtet die Administration über Webhooks ein.

## Beobachten
**👁 Beobachten** gibt es am Testfall (Kopf der Ansicht), am Zyklus (Kopf) und am Testplan (neben *📄 Berichte*).
Eingeschaltet heißt die Schaltfläche **👁 Beobachtet**; die Zahl in Klammern nennt, wie viele Personen beobachten.
Kontomenü → **👁 Beobachtet…** listet alles, was Sie beobachten, mit Sprung zum Objekt und **Nicht mehr
beobachten**. Die Mails kommen nur, wenn unter *Benachrichtigungen* „Änderungen an Testfällen, Zyklen und Testplänen,
die ich beobachte (👁)“ gewählt ist.

| Beobachtet | Gemeldet wird |
|---|---|
| Testfall | neue Version (mit Änderungsnotiz), Statuswechsel, archiviert, wiederhergestellt, gelöscht, neuer Kommentar in der Diskussion, fehlgeschlagene Ausführung des Testfalls |
| Zyklus | fehlgeschlagene Ausführung, Zyklus archiviert, wiederhergestellt oder gelöscht, explorative Sitzung abgeschlossen |
| Testplan | fehlgeschlagene Ausführung in einem seiner Zyklen, neuer Zyklus, Zyklus archiviert, wiederhergestellt oder gelöscht, Freigabeentscheidung, Fazit geändert |

Eigene Aktionen werden nicht gemeldet, und jede Person erhält ein Ereignis nur einmal, auch wenn sie z. B. Testfall
und Zyklus beobachtet. Bei Projekten mit gesperrten externen Diensten enthält die Mail nur einen Hinweis ohne Inhalt.

## API und Skripte
Kontomenü → **API-Tokens**: Token erzeugen (wird nur einmal angezeigt) und als `Authorization: Bearer …` senden.
Ein Token handelt mit Ihren Rechten. Die Schnittstellenbeschreibung steht unter `/api/openapi.json`.

## Ergebnisse aus CI-Pipelines
Die Ergebnisdatei an `POST /api/projects/<PROJEKT>/automation-results?cycle=…&build=…` senden. Das Format wird
automatisch erkannt: JUnit-XML, Cucumber-JSON, Behave-JSON, TestNG, NUnit, xUnit.net, MSTest (TRX), Robot Framework
(`output.xml`), Playwright-JSON und Jest-JSON (höchstens 20 MB). Die Zuordnung zum Testfall läuft über den Schlüssel im
Testnamen bzw. Tag (`DEMO-T12`, `@DEMO-T12`), den Jira-Altschlüssel oder einen gespeicherten Automatisierungsverweis.
Mit `createDefects=true` legt Anemo für fehlgeschlagene Tests Fehler in OpenProject an bzw. verknüpft einen offenen
Fehler des Testfalls. Ohne Pipeline geht derselbe Import als Datei in der Oberfläche (Zyklus → *⋯ Mehr → ⇧
Automatisierte Ergebnisse …*, siehe [Planung & Durchführung](03-planung-durchfuehrung.md)); dort lassen sich nicht
erkannte Ergebnisse auch dauerhaft zuordnen. Anleitung und GitLab-CI-Beispiel: [automation.md](../automation.md).

## CI-Pipeline aus Anemo starten
Im Zyklus startet **⋯ Mehr → ▶ CI-Pipeline starten…** eine GitLab-Pipeline (siehe
[Planung & Durchführung](03-planung-durchfuehrung.md#ci-pipeline-starten)). Anemo übergibt die Variablen:

| Variable | Inhalt |
|---|---|
| `ANEMO_URL` | Adresse von Anemo |
| `ANEMO_PROJECT` | Projektschlüssel, z. B. `DEMO` |
| `ANEMO_CYCLE_ID` | ID des Zyklus, in den die Ergebnisse gehören |
| `ANEMO_CYCLE_NAME` | Name des Zyklus |
| `ANEMO_BUILD` | Build des Zyklus (nur wenn gesetzt) |

Die Pipeline meldet ihre Ergebnisse mit einem API-Token (Rolle *Ausführen*, am besten eines technischen Benutzers),
das in GitLab als geschützte, maskierte CI-Variable `ANEMO_TOKEN` hinterlegt ist. Beispiel für `.gitlab-ci.yml`:

```yaml
test:
  stage: test
  script:
    - ./tests-ausfuehren.sh        # schreibt die Ergebnisse als JUnit-XML nach report.xml
  artifacts:
    when: always
    paths: [report.xml]

anemo-ergebnisse:
  stage: .post
  when: always
  rules:
    - if: $ANEMO_CYCLE_ID          # nur, wenn die Pipeline aus Anemo gestartet wurde
  script:
    - >
      curl --fail -X POST
      -H "Authorization: Bearer $ANEMO_TOKEN" -H "Content-Type: application/xml"
      --data-binary @report.xml
      "$ANEMO_URL/api/projects/$ANEMO_PROJECT/automation-results?cycleId=$ANEMO_CYCLE_ID"
```

Mit `&build=$ANEMO_BUILD` bzw. `&createDefects=true` lassen sich Build und automatische Fehler ergänzen. Die
Testfälle werden wie oben über Schlüssel, Tag oder Automatisierungsverweis zugeordnet.

## KI-Agenten (MCP)
Claude und andere Agenten nutzen Anemo über das Model Context Protocol (`/api/mcp`). Sie können suchen, Testfälle
lesen, Zyklen planen, Ergebnisse und Evidenzen erfassen, Unklares eskalieren und Fehler vorbereiten. Sie handeln
mit den Rechten des Token-Benutzers. Projekte mit gesperrten externen Diensten sind für Agenten unsichtbar.
Ergebnisse von Agentenkonten brauchen eine QA-Freigabe. Einrichtung in Claude Code, Claude Desktop, Codex, OpenCode, pi,
Gemini CLI, Cursor und VS Code: [mcp.md](../mcp.md#einrichten); Tests durch Agenten: [agenten.md](../agenten.md).
