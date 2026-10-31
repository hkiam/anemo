# ADR-0019: Webhooks aus dem Ereignisprotokoll mit eigenem Lesezeiger

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Teams sollen erfahren, wenn etwas Relevantes passiert (neuer Fehlschlag, Zyklus angelegt, Nachtest), und fremde
Systeme sollen reagieren können. Das Ereignisprotokoll (ADR-0007) ist bereits die Outbox.

## Entscheidung
- Tabelle `webhook` mit **eigenem Lesezeiger** (`cursor_seq`) im Ereignisprotokoll. Ein Zusteller liest je Webhook
  die nächsten Ereignisse und stellt sie in Reihenfolge zu, mindestens einmal; Neustarts verlieren nichts.
  Neue Webhooks beginnen beim aktuellen Ende, ältere Ereignisse werden nicht nachgeliefert.
- **Filter:** Ereignistypen und Projekt. Ereignisse aus Projekten mit gesperrten externen Diensten werden nie
  gesendet (ADR-0014).
- **Formate:** `json` mit Ereignis und Projekt, signiert als `X-Anemo-Signature: sha256=<HMAC>`, Geheimnis wird
  einmal angezeigt; `chat` mit einem lesbaren `text` für Teams, Mattermost und Slack. Mit
  `ANEMO_PUBLIC_URL` enthält die Nachricht einen Link auf die Ausführung.
- **Fehler:** Wiederholung mit exponentiell steigender Wartezeit (bis 1 h). Nach 8 Fehlversuchen wird das Ereignis
  übersprungen und protokolliert. Die letzten 200 Zustellungen je Webhook bleiben sichtbar.
- Ziel-URLs legt nur die Systemadministration fest (nur http/https).

## Konsequenzen
Benachrichtigungen per E-Mail wären ein weiteres Format (SMTP-Zugang nötig). Langsame Empfänger verzögern nur den
eigenen Webhook.
