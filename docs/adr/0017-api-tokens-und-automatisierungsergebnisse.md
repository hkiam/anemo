# ADR-0017: API-Tokens und Übernahme von Automatisierungsergebnissen

- Status: angenommen
- Datum: 2026-10-11

## Kontext
CI-Pipelines und Agenten sollen ohne Browser-Sitzung mit Anemo arbeiten, ohne Sonderrechte. Automatisierte Tests
liefern ihre Ergebnisse als JUnit-XML oder Cucumber-JSON, und diese Ergebnisse sollen dort stehen, wo auch die
manuellen stehen: an den Testfällen in Zyklen.

## Entscheidung
- **API-Tokens** je Benutzer (`api_token`): `Authorization: Bearer anemo_…`. Gespeichert wird nur der
  SHA-256-Hash, das Token wird einmal angezeigt. Optionaler Ablauf, Widerruf, „zuletzt verwendet“. Ein Token
  handelt mit den Rollen seines Benutzers. Für Pipelines gibt es technische Benutzer mit passender Projektrolle,
  keine eigenen Token-Rechte.
- **Ergebnisimport** `POST /api/projects/{key}/automation-results` (Rolle „Ausführen“), Formaterkennung ohne
  Zusatzbibliothek. Der Zielzyklus kommt per ID oder Name (wird gefunden oder angelegt, mit Build/Release/
  Umgebung).
- **Zuordnung** in dieser Reihenfolge: Automatisierungsverweis am Testfall, Testfallschlüssel in Name, Klasse oder
  Tag, dann Jira-Altschlüssel. Neue Zuordnungen werden als Verweis `AUTOMATION` gespeichert. Mehrere Ergebnisse je
  Testfall ergeben das schlechteste. Fehlermeldungen stehen im Kommentar. Cucumber-Schritte werden zu
  Schrittergebnissen, wenn die Schrittzahl übereinstimmt. Nicht Zuordenbares wird gemeldet und nie geraten.

## Konsequenzen
Manuelle und automatisierte Ergebnisse stehen in denselben Auswertungen (Cockpit, Berichte, Test-Health).
Feingranulare Token-Rechte (z. B. nur Import) sind eine mögliche Erweiterung. Bis dahin begrenzt die Rolle des
technischen Benutzers den Zugriff.
