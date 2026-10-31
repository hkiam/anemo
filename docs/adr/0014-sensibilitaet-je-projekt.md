# ADR-0014: Sensibilität je Projekt – Zugriffsprotokoll und Sperre externer Dienste

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Ein Teil der Projekte hat besonderen Schutzbedarf (z. B. Projekte für Behörden). Neben der Sichtbarkeit nur für Mitglieder (ADR-0011) muss
nachvollziehbar sein, wer Inhalte angesehen hat. Außerdem dürfen solche Inhalte nicht unbemerkt an externe Dienste
abfließen, etwa an KI-Funktionen (Roadmap D) oder an Integrationen, die Inhalte übertragen (Roadmap B).

## Entscheidung
- **Zugriffsprotokoll** (`access_log`) für Projekte mit Sichtbarkeit „eingeschränkt“. Die zentrale Rechteprüfung
  schreibt jeden projektbezogenen Zugriff mit Zeitpunkt, Person, Stufe (lesen/ausführen/pflegen/verwalten), Objekt
  und Pfad. Abgelehnte Versuche stehen als `denied:<stufe>` darin. Wiederholungen derselben Person auf dasselbe
  Objekt werden 5 Minuten lang zusammengefasst. Ändernde Vorgänge stehen zusätzlich im Ereignisprotokoll.
- Einsicht haben Projektadmins und die Systemadministration. Die Aufbewahrung beträgt standardmäßig 2 Jahre
  (`ANEMO_ACCESS_LOG_DAYS`).
- **Externe Dienste** je Projekt: `allowed` oder `blocked`. Wird ein Projekt eingeschränkt, ist der Wert zunächst
  `blocked`. Eine Freigabe muss bewusst erfolgen und wird mit einer Rückfrage bestätigt. Künftige Integrationen und
  KI-Funktionen müssen diesen Wert prüfen, bevor Inhalte das System verlassen.

## Konsequenzen
Zugriffe auf sensible Projekte sind nachweisbar, ohne interne Projekte mit Protokolldaten zu belasten. Das Protokoll
enthält personenbezogene Daten und unterliegt deshalb der Aufbewahrungsfrist. Interne Projekte werden bewusst
nicht protokolliert.
