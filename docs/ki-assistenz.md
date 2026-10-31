# KI-Assistenz einrichten (optional)

Einrichtung bequem unter **Administration → KI** (Hauptschalter, Modell, Verbindungstest, Nutzung, Prompts) oder
per Umgebung wie unten. Werte aus der Oberfläche haben Vorrang. Konzept und geplante Skills:
[ki-konzept.md](ki-konzept.md).

Ähnliche Testfälle, Fehlerursachen-Cluster und Anforderungsabdeckung funktionieren **ohne** Sprachmodell
(Test-Health → Analysen), ebenso die risikobasierte Testauswahl (Zyklus → + Tests aufnehmen → ⚖ Risikobasiert).
Ein Modell ergänzt Entwürfe aus Anforderungen („✨ Aus Anforderung“), Cluster-Zusammenfassungen und verfeinert
auf Wunsch die Risikoauswahl anhand einer Änderungsbeschreibung (Skill „Risikobasierte Testauswahl“, jede
Anpassung mit Begründung).

```env
# on-prem mit vLLM (OpenAI-kompatibel), z. B. `vllm serve Qwen/Qwen3-8B --port 8000`
AI_BASE_URL=http://ki-server.firma.local:8000/v1
AI_MODEL=Qwen/Qwen3-8B
AI_ON_PREM=true            # nur setzen, wenn das Modell wirklich im eigenen Netz läuft
AI_EXTRA_BODY={"chat_template_kwargs": {"enable_thinking": false}}   # Qwen3: ohne Denkphase antworten

# Ollama: AI_BASE_URL=http://ki-server.firma.local:11434/v1, AI_MODEL=qwen3:8b

# oder Anthropic (externer Dienst – nur für Projekte mit erlaubten externen Diensten)
# AI_PROVIDER=anthropic
# AI_MODEL=claude-sonnet-5-5
# AI_API_KEY=…
```
Azure OpenAI: `AI_BASE_URL=https://<ressource>.openai.azure.com/openai/deployments/<deployment>` und `AI_API_KEY`.
