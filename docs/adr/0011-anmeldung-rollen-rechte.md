# ADR-0011: Anmeldung, Rollen je Projekt und deklarierte Rechteprüfung

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Bisher kam der Benutzer aus einem frei setzbaren Header. Für den Produktivbetrieb und vor allem für Projekte mit
besonderem Schutzbedarf (z. B. Behörden) braucht Anemo echte Anmeldung, Rollen und projektbezogene Sichtbarkeit. Integrationen
(Fehlermeldung im Namen einer Person, Git, LDAP) setzen eine verlässliche Identität voraus. Abhängigkeiten sollen
minimal bleiben.

## Entscheidung
- **Lokale Konten** mit scrypt-Hash (`node:crypto`, keine Zusatzbibliothek), Passwortregel ≥ 12 Zeichen mit
  Buchstaben und Nicht-Buchstaben. `source` (`local`/`ldap`/`oidc`) ist vorbereitet für B5.
- **Sitzungen** über ein zufälliges 256-Bit-Token im Cookie `anemo_session` (HttpOnly, SameSite=Lax, Secure bei
  HTTPS). In der Datenbank liegt nur der SHA-256-Hash. Ablauf nach 7 Tagen bzw. 12 h Leerlauf. Deaktivieren und
  Passwortwechsel beenden alle Sitzungen des Kontos.
- **Schutz:** ändernde Anfragen nur vom eigenen Ursprung (Origin-Prüfung), Sperre nach 5 Fehlversuchen mit
  steigender Wartezeit, gleiche Fehlermeldung und Antwortzeit für unbekannte Benutzer.
- **Rollen je Projekt** als feste Stufen: `VIEWER` (lesen) < `TESTER` (ausführen, Ergebnisse, Evidenzen) <
  `DESIGNER` (Testfälle, Zyklen, Pläne pflegen) < `PROJECT_ADMIN` (Mitglieder verwalten). Rollen werden Benutzern
  direkt oder **Gruppen** zugewiesen; die höchste Rolle gilt. **Systemadministratoren** haben überall alle Rechte
  sowie den Administrationsbereich (Migration, Ereignisse, Konfigurationsregeln, Benutzer).
- **Sichtbarkeit je Projekt:** `internal` – jeder Angemeldete liest (implizit VIEWER); `restricted` – nur
  Mitglieder. Für Nichtmitglieder antwortet die API mit **404** statt 403, damit die Existenz nicht verraten wird.
  Listen, Suche und Rückwärtssuche filtern auf sichtbare Projekte.
- **Rechte werden an der Route deklariert** (`access: 'public' | 'authenticated' | 'admin' | {level, project}`);
  `project` benennt das Objekt (Testfall, Zyklus, Ausführung, Anhang …), das Auth-Modul ordnet es dem Projekt zu.
  Standard ist `authenticated` – keine Route ist versehentlich öffentlich. Die Prüffunktion hängt am Request-Kontext,
  die Plattform kennt das Auth-Modul nicht.
- **Erstinstallation:** gibt es keinen Benutzer, wird `admin` mit Zufallspasswort angelegt; das Passwort steht nur
  in `.data/initial-admin-password.txt` (Modus 0600) bzw. kommt aus `ANEMO_ADMIN_PASSWORD`, nie im Log.
- `ANEMO_AUTH=off` (nur Tests/Entwicklung) behält das bisherige Verhalten mit vollen Rechten und warnt beim Start.

## Konsequenzen
Der Akteur in Ereignissen und Ergebnissen stammt aus der Sitzung und ist nicht mehr fälschbar. Feingranulare
Einzelrechte sind bewusst nicht vorgesehen – vier Stufen decken die gelebten Rollen ab und bleiben verständlich.
Ein Zugriffsprotokoll für sensible Projekte (A5) und LDAP/OIDC (B5) bauen auf diesem Modell auf.
