/**
 * Optionaler Sprachmodell-Zugang (ADR-0023, ADR-0025): OpenAI-kompatibel (vLLM, Ollama, LM Studio, LocalAI,
 * Azure OpenAI, OpenAI …) oder Anthropic. Ohne Konfiguration oder mit AI_ENABLED=false arbeiten alle
 * Assistenzfunktionen regelbasiert. Jeder Aufruf wird ohne Inhalte protokolliert (Nutzung, Kostenbremse).
 */
import type { Db } from '../../platform/db.ts';
import { HttpError } from '../../platform/http.ts';
import { settingsEnv } from '../../platform/settings.ts';

export interface LlmConfig {
  provider: 'openai' | 'anthropic'; baseUrl: string; apiKey: string | null; model: string; onPrem: boolean;
  /** Zusätzliche Felder der Anfrage (AI_EXTRA_BODY), z. B. für Qwen3 auf vLLM {"chat_template_kwargs":{"enable_thinking":false}} */
  extraBody: Record<string, unknown> | null;
}

/** Felder, die Anemo je Anfrage festlegt: Modell (Protokoll, Kostenbremse), Nachrichten, Längengrenze, Streaming */
export const RESERVED_BODY = new Set(['model', 'messages', 'system', 'stream', 'max_tokens', 'max_completion_tokens', 'n']);

/** JSON-Objekt aus AI_EXTRA_BODY; alles andere ist ein Konfigurationsfehler. */
export function parseExtraBody(raw: string | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error('Zusätzliche Anfrageparameter: kein gültiges JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Zusätzliche Anfrageparameter: ein JSON-Objekt erwartet, z. B. {"top_k": 20}');
  const fixed = Object.keys(v).filter((k) => RESERVED_BODY.has(k));
  if (fixed.length) throw new Error(`Zusätzliche Anfrageparameter: ${fixed.join(', ')} legt Anemo selbst fest (Modell, Nachrichten, Längengrenze)`);
  return v as Record<string, unknown>;
}

/** Denkphase von Reasoning-Modellen (Qwen3, DeepSeek-R1 …) entfernen; abgeschnittene Denkphase ergibt leeren Text. */
export function stripThinking(text: string): string {
  // Manche Chat-Vorlagen (DeepSeek-R1-Distill, QwQ) setzen <think> schon in den Prompt: dann kommt nur </think>
  const close = text.lastIndexOf('</think>');
  if (close >= 0 && !text.slice(0, close).includes('<think>')) text = text.slice(close + '</think>'.length);
  const out = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = out.indexOf('<think>');
  return (open >= 0 ? out.slice(0, open) : out).trim();
}

export function aiEnabled(env: NodeJS.ProcessEnv = settingsEnv()): boolean {
  return env.AI_ENABLED !== 'false';
}

export type Profile = 'default' | 'strong';
export const PROFILES: Profile[] = ['default', 'strong'];

/** Modellprofil: „default“ = AI_*, „strong“ = AI_STRONG_* (optional, z. B. größeres externes Modell). */
export function llmConfig(env: NodeJS.ProcessEnv = settingsEnv(), profile: Profile = 'default'): LlmConfig | null {
  if (!aiEnabled(env)) return null;
  const p = profile === 'strong' ? 'AI_STRONG_' : 'AI_';
  const model = env[`${p}MODEL`], base = env[`${p}BASE_URL`], prov = env[`${p}PROVIDER`];
  if (!model || !(base || prov === 'anthropic')) return null;
  return {
    provider: prov === 'anthropic' ? 'anthropic' : 'openai', model, apiKey: env[`${p}API_KEY`] ?? null, onPrem: env[`${p}ON_PREM`] === 'true',
    extraBody: parseExtraBody(env[`${p}EXTRA_BODY`]),
    baseUrl: (base ?? 'https://api.anthropic.com').replace(/\/+$/, ''),
  };
}

/** Zustand für Oberfläche und Administration. */
export function aiState(env: NodeJS.ProcessEnv = settingsEnv()) {
  let configError: string | null = null;
  const safe = (profile: Profile) => { try { return llmConfig(env, profile); } catch (e) { configError = (e as Error).message; return null; } };
  const cfg = safe('default'), strong = safe('strong');
  return {
    enabled: aiEnabled(env),
    configured: !!(env.AI_MODEL && (env.AI_BASE_URL || env.AI_PROVIDER === 'anthropic')),
    llm: cfg ? { provider: cfg.provider, model: cfg.model, onPrem: cfg.onPrem } : null,
    strong: strong ? { provider: strong.provider, model: strong.model, onPrem: strong.onPrem } : null,
    configError,
    agentsEnabled: env.AGENTS_ENABLED !== 'false',
    maxPerHour: Number(env.AI_MAX_REQUESTS_PER_HOUR ?? 200),
  };
}

type Fetch = typeof fetch;
let http: Fetch = fetch;
/** Nur für Tests */
export function setLlmFetch(f: Fetch | null): void {
  http = f ?? fetch;
}

/** Eine Anfrage (System + Nutzertext) → Antworttext. JSON-Antworten werden über den Prompt angefordert. */
export async function complete(cfg: LlmConfig, system: string, user: string, maxTokens = 2000): Promise<string> {
  if (cfg.provider === 'anthropic') {
    const res = await http(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, ...cfg.extraBody, system, messages: [{ role: 'user', content: user }] }),
    });
    const d = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message: string } };
    if (!res.ok) throw new Error(`KI-Modell: ${d.error?.message ?? res.status}`);
    return stripThinking((d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
  }
  const res = await http(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}`, 'api-key': cfg.apiKey } : {}) },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, temperature: 0.2, ...cfg.extraBody, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const d = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
  if (!res.ok) throw new Error(`KI-Modell: ${d.error?.message ?? res.status}`);
  // vLLM mit --reasoning-parser liefert die Denkphase getrennt (reasoning_content), sonst steht sie als <think> im Text
  return stripThinking(d.choices?.[0]?.message?.content ?? '');
}

export interface AskMeta { feature: string; actor: string; projectId: string | null }

/** Wie {@link complete}, aber mit Kostenbremse und Nutzungsprotokoll (ohne Inhalte). */
export async function ask(db: Db, cfg: LlmConfig, meta: AskMeta, system: string, user: string, maxTokens = 2000): Promise<string> {
  const max = aiState().maxPerHour;
  const t0 = Date.now();
  // Kontingent atomar prüfen und reservieren (parallele Anfragen dürfen es nicht überschreiten)
  let reserved: string | null = null;
  if (max > 0) {
    reserved = await db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('anemo-ai-quota'))`;
      const [r] = await tx<{ n: number }[]>`select count(*)::int as n from ai_call_log where at > now() - interval '1 hour'`;
      if ((r?.n ?? 0) >= max) throw new HttpError(429, `KI-Kontingent erschöpft (${max} Anfragen pro Stunde) – bitte später erneut versuchen.`);
      const [row] = await tx<{ id: string }[]>`insert into ai_call_log(actor, project_id, feature, model, prompt_chars, duration_ms, ok, error)
        values (${meta.actor}, ${meta.projectId}, ${meta.feature}, ${cfg.model}, ${system.length + user.length}, 0, false, 'läuft') returning id`;
      return row!.id;
    });
  }
  try {
    const out = await complete(cfg, system, user, maxTokens);
    if (reserved) await db`update ai_call_log set response_chars = ${out.length}, duration_ms = ${Date.now() - t0}, ok = true, error = null where id = ${reserved}`;
    else await db`insert into ai_call_log(actor, project_id, feature, model, prompt_chars, response_chars, duration_ms, ok)
             values (${meta.actor}, ${meta.projectId}, ${meta.feature}, ${cfg.model}, ${system.length + user.length}, ${out.length}, ${Date.now() - t0}, true)`;
    return out;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    if (reserved) await db`update ai_call_log set duration_ms = ${Date.now() - t0}, ok = false, error = ${msg} where id = ${reserved}`.catch(() => {});
    else await db`insert into ai_call_log(actor, project_id, feature, model, prompt_chars, duration_ms, ok, error)
             values (${meta.actor}, ${meta.projectId}, ${meta.feature}, ${cfg.model}, ${system.length + user.length}, ${Date.now() - t0}, false, ${msg})`.catch(() => {});
    throw e;
  }
}

/** JSON aus einer Modellantwort lesen (auch wenn es in ```json … ``` steht). */
export function parseJson<T>(text: string): T {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (m ? m[1]! : text).trim();
  const start = raw.search(/[[{]/);
  return JSON.parse(start > 0 ? raw.slice(start) : raw) as T;
}
