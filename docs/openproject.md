# OpenProject-Anbindung

## Einrichten
1. API-Schlüssel eines technischen OpenProject-Benutzers erzeugen (Rechte: Arbeitspakete in den Zielprojekten
   ansehen, anlegen und kommentieren).
2. Im Anemo-Container bzw. in `.env`: `OPENPROJECT_URL`, `OPENPROJECT_API_KEY`, für klickbare Rückverweise
   `ANEMO_PUBLIC_URL`.
3. *Administration → Integrationen*: Verbindung prüfen, je Anemo-Projekt das OpenProject-Projekt (Kennung) und die
   Typ-ID für Fehler (z. B. „Bug“) zuordnen.

## Funktionen
- **Verknüpfen** (Testfall, Testzyklus, Testplan, Ausführung → Arbeitspaket): Dialog „🔗 Verknüpfen…“ mit
  Live-Suche in OpenProject. Das Arbeitspaket erhält einen **Kommentar mit Rückverweis** auf Anemo.
- **Fehler melden** aus der Durchführung: Vorlage → prüfen → „In OpenProject anlegen“. Beschreibung in Markdown
  mit Umgebung, Konfiguration, Reproduktionsschritten, Ist/Soll und Rückverweis. Verknüpfung als Fehler.
- **Statusabgleich** alle 15 Minuten (`ANEMO_OPENPROJECT_REFRESH_MINUTES`) oder manuell. Wechselt ein verknüpfter
  Fehler auf erledigt, legt Anemo einen **Nachtest** im selben Zyklus an, zugewiesen an die Person, die den
  Fehler gefunden hat. Gilt ebenso für Jira-Fehler.
- Projekte mit gesperrten externen Diensten übertragen nichts nach OpenProject.

## Lokale Testinstanz
Eine lokale OpenProject-Testinstanz (offizielles Docker-Compose-Setup) belegt standardmäßig Port 8090 wie das
Anemo-Backend. Für den gemeinsamen Betrieb mit verschobenem Port im Ordner der Instanz starten (ohne Dateien zu
ändern):

```bash
PORT=127.0.0.1:8095 OPENPROJECT_HOST__NAME=localhost:8095 OPENPROJECT_ADDITIONAL__HOST__NAMES='["web","127.0.0.1:8095","127.0.0.1","localhost:8095"]' docker compose up -d
```
