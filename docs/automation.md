# Ergebnisse automatisierter Tests übernehmen

Anemo übernimmt Ergebnisse aus CI-Pipelines als Ausführungen in einen Testzyklus. Unterstützt werden
**JUnit-XML** (Maven Surefire/Failsafe, Gradle, pytest `--junitxml`, Jest mit jest-junit, Playwright, …) und
**Cucumber-JSON** (die Schritte eines Szenarios werden zu Schrittergebnissen, wenn der Testfall im Gherkin-Format
dieselben Schritte hat).

## Zuordnung zum Testfall
1. **Automatisierungsverweis** am Testfall (Verweis „Automatisierung“, System `automation`, Kennung
   `Klasse.Testname` bzw. `feature-datei:Szenario`). Er wird beim ersten Import automatisch angelegt, damit
   Umbenennungen von Testfällen nicht stören.
2. **Testfallschlüssel** im Testnamen, in der Klasse oder als Tag: `DEMO-T12`, `DEMO_T12`, `@DEMO-T12`.
3. **Jira-Altschlüssel** des Testfalls (z. B. `PROJ-1234`).
4. **Fundstelle** (`datei.feature:Zeile`, nur Cucumber): wurde ein Szenario einmal sicher zugeordnet, wird seine
   Fundstelle gemerkt. Fehlt später der Tag, ordnet Anemo über die Fundstelle zu. Zeilen verschieben sich beim
   Bearbeiten, deshalb ist das die letzte Stufe – Tags mit dem Testfallschlüssel bleiben der sichere Weg.

Nicht zuordenbare Tests werden in der Antwort unter `unmapped` gemeldet und nicht angelegt.

## Aufruf
Ein API-Token mit der Rolle „Ausführen“ im Projekt erzeugen (Menü oben rechts → *API-Tokens*, am besten für einen
technischen Benutzer).

```bash
curl --fail -X POST \
  -H "Authorization: Bearer $ANEMO_TOKEN" -H "Content-Type: application/xml" \
  --data-binary @target/surefire-reports/TEST-all.xml \
  "https://anemo.example/api/projects/DEMO/automation-results?cycle=Nightly%20$CI_COMMIT_REF_NAME&build=$CI_PIPELINE_IID"
```

Parameter:

| Parameter | Bedeutung |
|---|---|
| `cycleId` | Ergebnisse in genau diesen Zyklus schreiben (empfohlen für mehrere Berichte, z. B. je Gerät: Zyklus vorher anlegen) |
| `cycle` | Name für einen **neuen** Zyklus. Gibt es den Namen schon, entsteht ein neuer Zyklus mit Zusatz „(2)“ und einem Hinweis in `warnings` – Läufe werden nie still zusammengeführt |
| `ifExists=append` | mit `cycle`: in den offenen Zyklus gleichen Namens ergänzen (früheres Verhalten). Weichen Umgebung, Build oder Konfiguration ab, steht das in `warnings` |
| `device` | Gerät als Konfigurationsmerkmal (z. B. `iPad`) – Grundlage für „Stand je Konfiguration“ im Cockpit |
| `configuration` | weitere Merkmale, z. B. `os=iOS;browser=Safari` (im JSON-Körper als Objekt) |
| `planId`, `build`, `release`, `environment` | Zuordnung und Angaben zum Lauf |
| `format` | `junit`/`cucumber`/…; sonst automatisch erkannt |

Die Antwort nennt `cycleId`, `cycleName`, `cycleCreated` und `warnings`.

### Mehrere Ergebnisse je Testfall
- **Wiederholungsversuche** (Rerun-Plugins, `retry` in Playwright): dasselbe Szenario (gleiche Fundstelle bzw.
  Kennung) mehrfach im Bericht – der **letzte Versuch zählt**. Bestanden erst im Wiederholungsversuch steht in
  `retriedPassed`, im Ergebnisverlauf und macht den Testfall in Test-Health zu „wackelnd“.
- **Szenario-Grundriss** (Scenario Outline): hat der Testfall einen Datensatz mit genau so vielen Zeilen wie
  Beispiele im Bericht, wird jedes Beispiel (nach Zeile sortiert) ein Durchlauf. Sonst werden die Ergebnisse
  zusammengefasst – das schlechteste zählt, Fehlermeldungen stehen im Kommentar.

### Bekannte Fehler
Szenarien mit dem Tag `@bekannter-fehler` (auch `@known-failure`) erhalten bei Fehlschlag den Status
**„Fehlgeschlagen (bekannt)“**. Mit `@fehler:<Ticket>` (z. B. `@fehler:DEMO-315`) wird das Ticket als Fehler
verknüpft; anderer Text nach `@fehler:` steht als Befund im Kommentar. Bekannte Fehler blockieren die
Freigabeempfehlung nicht, erscheinen aber im Cockpit und im Abschlussbericht als Restrisiko (Ausstiegskriterium
„Bekannte Fehler höchstens n“ möglich). Für bekannte Fehler werden keine Tickets automatisch angelegt.

## GitLab-CI-Beispiel
```yaml
anemo:
  stage: .post
  when: always
  script:
    - >
      curl --fail -X POST -H "Authorization: Bearer $ANEMO_TOKEN" -H "Content-Type: application/xml"
      --data-binary @report.xml
      "$ANEMO_URL/api/projects/DEMO/automation-results?cycle=Pipeline%20$CI_COMMIT_REF_NAME&build=$CI_PIPELINE_IID"
```
