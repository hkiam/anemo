# Sicherheit

## Unterstützte Versionen

Sicherheitskorrekturen erscheinen für die jeweils neueste Version (siehe [CHANGELOG.md](CHANGELOG.md)).

## Schwachstelle melden

Bitte melde Sicherheitslücken **vertraulich** über die Funktion *Security → Report a vulnerability* dieses
Repositorys (GitHub Private Vulnerability Reporting) und nicht als öffentliches Issue.

Hilfreich sind: betroffene Version, Beschreibung und Auswirkung, Schritte zum Nachstellen bzw. ein Proof of Concept
sowie gegebenenfalls ein Vorschlag zur Behebung. Wir bestätigen den Eingang in der Regel innerhalb weniger Tage,
halten dich über den Stand auf dem Laufenden und nennen dich nach der Veröffentlichung der Korrektur gern als
Finder:in, sofern du das möchtest.

## Hinweise für den Betrieb

- Anemo hinter einem Reverse-Proxy mit TLS betreiben und `ANEMO_PUBLIC_URL` setzen.
- Das Kennwort des ersten Kontos `admin` nach der Anmeldung ändern und `initial-admin-password.txt` löschen.
- Geheimnisse (Tokens, Client-Secrets) werden verschlüsselt gespeichert; den Schlüssel `ANEMO_SECRET_KEY` bzw. die
  Datei `secret.key` gemeinsam mit der Sicherung schützen.
- Weitere Hinweise: [Betriebshandbuch](docs/handbuch/20-betrieb.md).
