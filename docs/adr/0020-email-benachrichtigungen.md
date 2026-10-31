# ADR-0020: E-Mail-Benachrichtigungen mit eigenem SMTP-Client

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Tester sollen erfahren, wenn ihnen Ausführungen zugewiesen werden oder ein Nachtest fällig ist. Wer einen Zyklus
verantwortet, soll erfahren, wenn darin etwas fehlschlägt. Abhängigkeiten sollen minimal bleiben.

## Entscheidung
- **SMTP-Client ohne Bibliothek** (`platform/smtp.ts`): implizites TLS oder STARTTLS, AUTH PLAIN/LOGIN,
  UTF-8-Betreff, Text in Base64, `Auto-Submitted: auto-generated`. Konfiguration über `SMTP_*`.
- **Abonnements je Benutzer** (`user_notification`): Zuweisung, Nachtest fällig, Fehlschlag in eigenen Zyklen.
  Voreinstellung bei neuen Benutzern: Zuweisung und Nachtest. Jeder legt seine Adresse und Auswahl selbst fest.
- **Versand** über einen Lesezeiger im Ereignisprotokoll (`mail_state`), wie bei den Webhooks. Je Durchlauf
  (minütlich) geht **eine Sammelmail je Empfänger** raus. Eigene Aktionen lösen keine Mail aus. Ist der Server
  nicht erreichbar, bleibt der Lesezeiger stehen und der Versand wird mit wachsendem Abstand wiederholt.
- Aus Projekten mit gesperrten externen Diensten geht nur ein Hinweis mit Link, ohne Titel oder Inhalte.

## Konsequenzen
Kein HTML-Mailformat und keine Tages-Zusammenfassung; beides lässt sich später ergänzen. Mails gehen nur an Konten
mit hinterlegter Adresse.
