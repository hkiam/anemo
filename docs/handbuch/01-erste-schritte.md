# Erste Schritte

## Anmelden
Je nach Einrichtung gibt es drei Wege:
- **Mit Firmenkonto anmelden** (Schaltfläche): Weiterleitung zu Keycloak bzw. Microsoft Entra ID. Ihr Konto und
  Ihre Gruppen werden dabei automatisch übernommen.
- **Benutzername und Domänenpasswort**, wenn LDAP/Active Directory angebunden ist.
- **Lokales Konto**, angelegt von der Administration.

Nach fünf falschen Passworteingaben wird die Anmeldung kurz gesperrt. Eine Sitzung endet nach 12 Stunden ohne
Aktivität bzw. spätestens nach 7 Tagen. „Abmelden“ meldet Firmenkonten auch beim Identitätsanbieter ab.

## Startseite
Nach der Anmeldung und mit Klick auf **Anemo** (oben links) öffnet die **Startseite** des Projekts:
- **Kennzahlen**: Testfälle, offene Ausführungen, heute bzw. in den letzten 7 Tagen ausgeführt.
- **Meine Aufgaben**: Ihnen zugewiesene offene Ausführungen (Zyklen mit nahem Ende zuerst) mit **▶ Weiter testen**,
  eigene explorative Sitzungen und eigene Entwürfe.
- **Aufgaben der Testleitung** (mit Rolle *Pflegen*): Testfälle, die auf Ihre Vier-Augen-Freigabe warten,
  KI-Ergebnisse zur Prüfung und Sitzungen ohne Nachbesprechung.
- **Releases**, **Aktive Testzyklen**, **Zuletzt fehlgeschlagen**, **Zuletzt geänderte Testfälle**, **Test-Health**
  und **Schnellzugriff**.

**⚙ Anpassen** blendet Kacheln ein oder aus und ordnet sie mit ↑ ↓. Die Einstellung gilt nur für Sie und wird sofort
gespeichert; *Standard wiederherstellen* setzt sie zurück. Der Standard richtet sich nach Ihrer Rolle.

## Die Oberfläche
- **Kopfzeile**: Projektauswahl, Bereiche *Start*, *Testfälle*, *Planung & Ausführung*, *Test-Health*, ggf.
  *Administration* bzw. *Mitglieder*, die Schnellsuche (⌘K / Strg+K), die Hilfe (**?**) und Ihr Konto.
- **Hilfe zur Ansicht**: **?** in der Kopfzeile oder die Taste **F1** öffnet rechts den passenden Abschnitt dieses
  Handbuchs – etwa *Ausführen*, wenn eine Ausführung offen ist. Die Leiste bleibt beim Arbeiten offen und folgt dem
  Seitenwechsel. Darin: **Thema suchen**, **Verwandte Themen** und **Ganzes Kapitel im Handbuch öffnen** (neuer Tab,
  Eingaben bleiben erhalten). Dialoge tragen neben dem Titel ein **?** für die Hilfe genau zu diesem Dialog.
  Schließen mit ✕, Esc (in der Leiste) oder erneut F1.
- **Kontomenü** (oben rechts): Kennwort ändern (lokale Konten), *Benachrichtigungen*, *API-Tokens*, *👁 Beobachtet…* (was Sie beobachten), *⌨ Tastenkürzel*,
  *Abmelden*. Die Kürzelübersicht öffnet auch die Taste `?`.
- Links lassen sich teilen: jede Ansicht, jeder Filter und jede Ausführung hat eine eigene Adresse.
- **⧉ Fokusfenster**: Durchführung, Testfall-Editor, Testplan und Testzyklus lassen sich in einem eigenen, großen
  Fenster ohne Navigation öffnen, z. B. auf dem zweiten Bildschirm. Strg/Cmd-Klick öffnet stattdessen einen Tab.
  Was dort gespeichert wird, erscheint sofort in den Listen des Hauptfensters.
- **Ungespeicherte Eingaben** sind geschützt: Beim Wechseln, Schließen oder Neuladen fragt Anemo nach.
  Gespeichertes wird unten rechts kurz bestätigt. Der Fenstertitel zeigt Projekt bzw. Testfall, damit mehrere
  Fenster unterscheidbar bleiben.

## Suchen
Die **Schnellsuche** durchsucht Testfälle (Titel, Inhalt, Schlüssel, Jira-Altschlüssel), Zyklen, Testpläne,
Ausführungskommentare, Ticketverweise und Anhänge, über alle Projekte, die Sie sehen dürfen. „Alle Treffer“ öffnet
die Suchseite mit Filtern nach Art und Projekt. Beispiele: `DEMO-T12`, `PROJ-1234` (Jira), `Anmeldung`,
`screenshot-2.png`.

## Rollen
Rechte gelten je Projekt; die höchste Rolle zählt (direkt oder über eine Gruppe):

| Rolle | darf |
|---|---|
| **Lesen** | Testfälle, Zyklen, Ergebnisse, Berichte ansehen |
| **Ausführen** | zusätzlich Tests ausführen, Ergebnisse und Evidenzen erfassen, zuweisen, Fehler melden |
| **Pflegen** (Testleitung) | zusätzlich Testfälle, Ordner, Zyklen, Testpläne anlegen und ändern, Testfälle freigeben (nicht die eigene Änderung), KI-Ergebnisse prüfen, Zyklen abschließen, Freigabeentscheidung festhalten, Protokoll des Projekts einsehen |
| **Projektadmin** | zusätzlich Mitglieder und Rollen des Projekts verwalten, Projektregeln, KI-Kontext, Massenfreigabe von Testfällen |

Im Handbuch heißt die Rolle *Pflegen* auch **Testleitung** – gemeint ist dieselbe Rolle.

Systemadministratoren dürfen alles und sehen die *Administration*. In **internen** Projekten darf jede angemeldete
Person lesen. **Eingeschränkte** Projekte sehen nur ihre Mitglieder; für alle anderen existieren sie nicht.
Schaltflächen, für die Ihnen die Rolle fehlt, werden nicht angezeigt.

## Begriffe
Anemo verwendet die folgenden Begriffe einheitlich:

| Begriff | Bedeutung |
|---|---|
| **Version** | Stand eines Testfalls bzw. einer Vorbedingung (v1, v2 …). Jede inhaltliche Änderung erzeugt eine neue Version; Ausführungen bleiben bei der Version, mit der sie eingeplant wurden. |
| **Testfall-Freigabe** | Vier-Augen-Prüfung einer Testfallversion (Workflow-Status *Freigegeben*). |
| **Freigabeentscheidung** | Entscheidung über ein Release im Release-Cockpit (freigegeben, mit Auflagen, nicht freigegeben), mit abgelegtem Freigabestand. |
| **Exportfreigabe** | Zustimmung der Systemadministration zum Export eines eingeschränkten Projekts. |
| **KI-Ergebnisprüfung** | Bestätigen oder Ablehnen eines Ergebnisses, das ein KI-Agent erfasst hat. Kein „Freigeben“. |
| **Befund** | Tatsächliches Ergebnis bzw. Beobachtung bei einer Ausführung (Feld *Tatsächliches Ergebnis*). |
| **Kommentar** | Diskussion an einem Testfall, Zyklus oder einer Ausführung (mit Erwähnungen). |
| **Evidenz** | Anhang als Nachweis an einer Ausführung oder einem Schritt (Screenshot, Logdatei). |
| **Verantwortlich** | Person, die einen Testfall pflegt. |
| **Zuständig** | Person, die eine Ausführung erfassen soll. |
| **Protokoll** | Unveränderliches Ereignisprotokoll (Audit-Trail): wer hat wann was geändert. |
