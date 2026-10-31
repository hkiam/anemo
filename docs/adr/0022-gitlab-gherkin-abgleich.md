# ADR-0022: GitLab – Gherkin-Testfälle als .feature-Dateien, Verknüpfung mit Merge-Requests

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Gherkin-Szenarien leben oft auch im Repository, weil die Automatisierung sie ausführt. Fachliche Pflege
(Anemo) und Entwicklung (Git) sollen denselben Text nutzen, ohne sich gegenseitig zu überschreiben.

## Entscheidung
- Je Anemo-Projekt ein Repository, ein Zweig und ein Ordner (`project_integration`, Anbieter `gitlab`).
  Ein Gherkin-Testfall entspricht einer Datei `<Ordner>/<Schlüssel>-<titel>.feature`, gekennzeichnet durch das Tag
  `@<Schlüssel>`. Über dieses Tag findet auch der Cucumber-Import (ADR-0017) den Testfall.
- **Dreiwegeabgleich** über den zuletzt synchronisierten Stand (`gitlab_sync`: Pfad, Version, Inhalts-Hash). So
  ist erkennbar, ob Anemo oder Git geändert hat: gleich, in Anemo geändert, in Git geändert, nur in Anemo,
  nur in Git.
- **Nach Git schreiben**: alle in Anemo geänderten oder neuen Testfälle in **einem** Commit. Dateien, die in Git
  geändert wurden, überschreibt Anemo nie. **Aus Git übernehmen**: gewählte Dateien werden zu neuen Versionen
  (Änderungsnotiz mit Repository, Commit und Pfad) bzw. zu neuen Testfällen. Pfade außerhalb des Ordners werden
  abgelehnt.
- **Verknüpfungen** mit Merge-Requests (`gruppe/repo!iid`) und Commits (`gruppe/repo@sha`). Der Status der
  Merge-Requests wird regelmäßig abgeglichen.
- Projekte mit gesperrten externen Diensten werden nicht abgeglichen. API v4 mit Token, ohne Bibliothek.

## Konsequenzen
Konflikte, bei denen beide Seiten geändert haben, erscheinen als „in Git geändert“. Die Git-Fassung wird
übernommen, die Anemo-Änderung bleibt als Vorversion erhalten und lässt sich danach erneut einarbeiten.
Klassische Testfälle werden nicht exportiert.
