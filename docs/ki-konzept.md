# KI in Anemo – Stand und Vorschlag

KI ist in Anemo **optional**. Ein Hauptschalter unter *Administration → KI* steuert sie, und ohne Modell
funktioniert alles. Dieses Dokument zeigt, was heute geht, nach welchen Grundsätzen KI eingebaut wird und welche
Skills als Nächstes sinnvoll sind.

## 1. Was heute nutzbar ist

| Funktion | Wo | Arbeitsweise |
|---|---|---|
| Testfall-Entwurf aus Anforderung | Testfälle → ✨ Aus Anforderung | Sprachmodell (Prompt anpassbar); Entwurf öffnet im Editor, nichts wird still gespeichert |
| Fehlerursachen zusammenfassen | Test-Health → Analysen → Fehlerursachen | Cluster regelbasiert, Zusammenfassung per Sprachmodell |
| Ähnliche Testfälle / Duplikate | Test-Health → Analysen | regelbasiert (Textähnlichkeit) |
| Anforderungsabdeckung | Test-Health → Analysen | regelbasiert |
| KI-Agenten führen Tests aus | MCP-Schnittstelle, Planung → 🤖 Freigaben | externer Agent; Ergebnisse brauchen eine QA-Freigabe |

**Einstellungen:**
- Hauptschalter und Agentenschalter.
- Modell (OpenAI-kompatibel oder Anthropic), Kennzeichnung on-prem, Kontingent pro Stunde.
- Verbindungstest, Nutzungsprotokoll ohne Inhalte und anpassbare Prompts je Funktion.
- Je Projekt „externe Dienste gesperrt“: Dort arbeitet nur ein on-prem-Modell, und Agenten sehen das Projekt nicht.

**Seit Stufe G vorhanden:**
- zwei Modellprofile (Standard und „stark“) mit Wahl je Skill;
- Projektkontext (Glossar, Stilregeln);
- Skills im Editor (✨ Prüfen), in der Fehlermeldung (✨ Formulieren) und im Cockpit (✨ Fazit);
- Kennzeichnung „mit KI erstellt“ an der Version.

**Noch offen:**
- Bewertung der Antwortqualität mit Referenzsets;
- Skills der Stufen 3 und 4 (siehe unten).

## 2. Grundsätze
1. **Vorschlag statt Automatik**: KI liefert Entwürfe, Hinweise und Begründungen. Ein Mensch übernimmt, ändert
   oder verwirft. Gespeichertes trägt den Vermerk „mit KI erstellt (Modell, Skill-Version)“.
2. **Datenschutz je Projekt**:
   - Sensible Projekte nutzen nur on-prem-Modelle.
   - Inhalte gehen nur an das Modell, das für den Skill vorgesehen ist.
   - Protokolliert wird ohne Inhalte.
3. **Austauschbar**: Jeder Skill ist an ein Modellprofil gebunden, nicht an einen Anbieter. Alles, was
   OpenAI-kompatibel spricht (vLLM, Ollama, LM Studio, LocalAI, Azure OpenAI, OpenAI), funktioniert, außerdem
   Anthropic.
4. **Erklärbar und prüfbar**:
   - Strukturierte Ausgabe (JSON-Schema) mit Prüfung, dazu Begründungen und Quellen wie Anforderung, Schritt oder
     Screenshot.
   - Fehlerhafte Antworten werden abgefangen und nicht übernommen.
5. **Kosten im Griff**: Kontingent, kurze Eingaben (nur der nötige Kontext), Zwischenspeicher für identische
   Anfragen.

## 3. Bausteine (Vorschlag)

**Modellprofile**: z. B. *lokal* (vLLM mit Qwen 72B, on-prem) und *stark* (extern, nur für freigegebene Projekte).
Jeder Skill nennt ein bevorzugtes Profil und eines als Ausweichlösung. Ein Modell als on-prem zu kennzeichnen,
entscheidet die Administration bewusst.

**Skill** = Prompt + Eingabekontext + Ausgabeschema + Beispiele + Prüfung + Ort in der Oberfläche:
```yaml
key: testcase-review
title: Testfall prüfen
where: Testfall-Editor → ✨ Prüfen
profile: lokal
input: [testcase.title, testcase.steps, testcase.preconditions, project.glossary, project.style]
output: { findings: [{ severity: hoch|mittel|niedrig, step: number|null, problem: string, suggestion: string }] }
examples: 2 kommentierte Beispiele (gut/schlecht)
system: |
  Du bist erfahrener Testanalyst (ISTQB). Prüfe den Testfall auf: eindeutige, beobachtbare Erwartung je Schritt;
  fehlende Vorbedingungen oder Testdaten; zusammengefasste Schritte; Fachbegriffe laut Glossar; Rechtschreibung.
  Antworte NUR mit JSON nach Schema. Keine Befunde erfinden; ist alles gut, liefere eine leere Liste.
```
Skills werden mitgeliefert und in der Administration angepasst (wie heute die Prompts), versioniert und je Projekt
ergänzbar.

**Projektkontext** (je Projekt, optional):
- Glossar (Fachbegriffe, Abkürzungen), Stilregeln („Erwartung immer im Präsens“) und Systemüberblick.
- Skills binden ihn als `{{project.glossary}}` usw. ein. Er verbessert die Ergebnisse deutlich, ohne das Modell zu
  trainieren.

**Bewertung**:
- Je Skill ein kleines Referenzset aus Eingabe und erwartetem Ergebnis (z. B. 20 Testfälle mit bekannten Mängeln).
- „Skill prüfen“ zeigt Trefferquote und Abweichungen. Damit lassen sich Prompt- und Modellwechsel vergleichen,
  bevor sie für alle gelten.

## 4. Skill-Katalog (priorisiert)

| Prio | Skill | Ort in Anemo | Nutzen |
|---|---|---|---|
| 1 | **Testfall prüfen** (Review) | Editor → ✨ Prüfen | schnell bessere Testfälle, Einheitlichkeit über Teams |
| 1 | **Fehlermeldung formulieren** | Durchführung → 🐞 Fehler melden → ✨ | aus Schrittbefund, Konfiguration und Screenshots ein reproduzierbarer Fehlerbericht |
| 1 | **Testabschlussbericht: Fazit** | Bericht → ✨ Fazit entwerfen | Bewertung, Restrisiken, Empfehlung als Entwurf für die Freigabe |
| 2 | **Testdaten und Randfälle vorschlagen** | Editor → ✨ Randfälle | Äquivalenzklassen, Grenzwerte, Negativfälle |
| 2 | **Gherkin ↔ Schritte verbessern** | Editor (Umwandlung) | bessere Formulierung als die regelbasierte Umwandlung |
| 2 | **Risikobasierte Testauswahl** ✅ | Zyklus → + Tests aufnehmen → ⚖ Risikobasiert → ✨ mit KI verfeinern | regelbasierter Risikowert (Priorität, Fehlerhistorie, Wackeln, Änderung, Alter, offene Fehler, Anforderungen, Änderungsumfang); das Modell justiert die vorderen 80 anhand der Änderungsbeschreibung, je Anpassung mit Begründung (±30) |
| 2 | **Duplikate zusammenführen** | Test-Health → Duplikate → ✨ Zusammenführen | zusammengeführter Testfall-Entwurf aus zwei ähnlichen |
| 3 | **Screenshot-Vergleich** (multimodal) | Durchführung, Evidenz | Hinweis, ob der Screenshot zur Erwartung passt |
| 3 | **Fragen an den Testbestand** | Schnellsuche → „Frage stellen“ | z. B. „Welche Tests decken den PDF-Export ab, was ist offen?“ – Antwort mit Verweisen |
| 3 | **Veraltete Testfälle aktualisieren** | Test-Health → veraltet | Vorschlag aus Release Notes bzw. geänderten Anforderungen |
| 3 | **Agent führt Web-Tests aus** | MCP + Playwright | Gherkin → automatisierter Lauf, Ergebnis mit Evidenzen zur QA-Freigabe; siehe [BDD-Beispiel](bdd-e2e-beispiel.md) |

## 5. Beispiel-Prompts

**Fehlermeldung formulieren** (Ausgabe JSON):
```text
Du bist QA-Ingenieur. Formuliere aus den Angaben eine Fehlermeldung für das Entwicklungsteam.
Eingaben: Testfall (Titel, Schritte), fehlgeschlagener Schritt mit Ist-Ergebnis, Konfiguration (DB, Client, Build),
Kommentar des Testers, Namen der angehängten Screenshots.
Antworte NUR mit JSON: {"title": string (max. 100 Zeichen, Symptom + Ort),
"steps": [string], "expected": string, "actual": string, "environment": string, "severity": "blocker|major|minor",
"notes": string}. Erfinde keine Schritte; fehlt eine Angabe, schreibe "unbekannt".
```

**Testabschlussbericht – Fazit**:
```text
Du bist Testmanager. Bewerte den Teststand für die Freigabe nach ISO/IEC/IEEE 29119-3.
Eingaben: Kennzahlen je Status, offene Fehler mit Schwere, nicht ausgeführte Tests je Komponente,
ungetestete Änderungen, Ein-/Ausstiegskriterien des Testplans.
Liefere: 1) Bewertung in 3–5 Sätzen, 2) Restrisiken als Liste mit Begründung, 3) Empfehlung
(freigeben / mit Auflagen / nicht freigeben) mit Bedingung. Nur Aussagen, die aus den Eingaben folgen.
```

## 6. Ausbaustufen
1. **Grundlage** (umgesetzt): Hauptschalter, Modell, on-prem-Regel, Kontingent, Protokoll, Prompts, zwei Skills.
2. **Arbeitshilfen** (umgesetzt): Modellprofile, Projektkontext (Glossar/Stil), Kennzeichnung „mit KI erstellt“,
   Skills *Testfall prüfen*, *Fehlermeldung formulieren*, *Abschlussbericht-Fazit*.
3. **Planung und Analyse** (begonnen): risikobasierte Auswahl ✅ (Stufe H), Randfälle, Duplikate zusammenführen, Fragen an den Bestand
   (mit Volltext- bzw. Vektorsuche, lokal).
4. **Automatisierung**: Agenten mit Playwright für Web-Tests aus Gherkin, Screenshot-Vergleich, Bewertung mit
   Referenzsets je Skill.

## 7. Modellwahl (Orientierung)
- **On-prem** (sensible Projekte): Instruct-Modelle der Klasse 30–70 Mrd. Parameter über vLLM bzw. Ollama, z. B. die
  Familien Qwen, Llama oder Mistral. Für Skills mit strukturierter Ausgabe genügen oft 14–32 Mrd. Für die Hardware
  gilt grob: 70 Mrd. Parameter in 4-Bit-Quantisierung brauchen etwa 40–48 GB GPU-Speicher.
- **Extern** (freigegebene Projekte): große Modelle von Anthropic bzw. OpenAI. Sie sind besser bei langen
  Berichten, Screenshots und Agentenarbeit.
- Welches Modell genügt, entscheiden die Referenzsets aus Stufe 4, nicht das Bauchgefühl.
