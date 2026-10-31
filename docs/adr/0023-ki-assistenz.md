# ADR-0023: Assistenz regelbasiert, Sprachmodell optional und begrenzt

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Gewünscht sind Duplikaterkennung, Gherkin-/Testfallvorschläge, Anforderungsabdeckung und Fehlerursachen-Cluster.
Ein Teil der Projekte ist sensibel, ein freigegebenes Modell steht noch nicht fest. Ergebnisse müssen
nachvollziehbar bleiben.

## Entscheidung
- **Ohne Modell** (immer verfügbar, unter Test-Health → Analysen):
  - **Ähnliche Testfälle**: Trigramm-Ähnlichkeit von Titel (40 %) und Inhalt (60 %), Kandidaten über einen
    invertierten Index (Projekt mit mehreren hundert Testfällen: unter 0,5 s).
  - **Fehlerursachen-Cluster**: Befunde fehlgeschlagener/blockierter Ausführungen. Zahlen, Kennungen, Pfade,
    Datumsangaben, Füllwörter und in vielen Befunden vorkommende Umgebungsangaben werden ausgeblendet. Gruppiert
    wird gegen den ersten Befund eines Clusters (keine Verkettung) bzw. über den gleichen verknüpften Fehler.
  - **Anforderungsabdeckung**: verknüpfte Anforderungen, Stories und Epics × letztes Ergebnis der Testfälle.
- **Mit Modell (optional)**: Testfall-Entwurf aus Anforderungstext und Kurz-Zusammenfassung von Clustern.
  Unterstützt werden OpenAI-kompatible Schnittstellen (Ollama, vLLM, LM Studio, Azure) und Anthropic. Entwürfe
  öffnen im Editor und werden erst nach menschlicher Prüfung gespeichert.
- **Datenschutz**: Ein Modell gilt als externer Dienst. Projekte mit gesperrten externen Diensten nutzen es nur,
  wenn es ausdrücklich als on-prem gekennzeichnet ist (`AI_ON_PREM=true`).

## Nachtrag 2026-10-30: Modellbetrieb on-prem
Festgelegt ist: Die Sprachmodelle laufen **on-prem** hinter einer OpenAI-kompatiblen Schnittstelle (vLLM o. ä.).
Vorgesehen sind mehrere Modelle, etwa Qwen3-8B. Sie werden über die Modellprofile Standard und „stark“ je Skill
zugeordnet; ein vLLM-Dienst je Modell oder ein Router davor. Qwen3 und andere Reasoning-Modelle schreiben ihre
Denkphase als `<think>…</think>` in die Antwort. Anemo entfernt sie vor der Auswertung. Über `AI_EXTRA_BODY`
(JSON, je Profil) gehen modellspezifische Parameter mit, z. B. `{"chat_template_kwargs": {"enable_thinking": false}}`.

## Konsequenzen
Die Assistenz ist sofort nutzbar und erklärbar. Embeddings und semantische Suche lassen sich später ergänzen,
wenn ein freigegebenes Modell feststeht.
