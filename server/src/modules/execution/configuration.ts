/**
 * Testkonfigurationen: strukturierte Merkmale eines Testzyklus (Datenbank, Client, Betriebssystem …),
 * regelbasiert aus Zyklusname, Umgebung und Build erkannt – erklärbar über die gespeicherten Belege.
 * Manuell gesetzte Konfigurationen haben Vorrang und werden von der Automatik nie überschrieben.
 */
import type { Db } from '../../platform/db.ts';
import { badRequest, notFound } from '../../platform/http.ts';

export interface ConfigValue { id: string; dimensionKey: string; value: string; description: string | null; patterns: string[]; sortOrder: number }
export interface ConfigDimension {
  key: string; name: string; description: string | null; sortOrder: number; extractPattern: string | null; values: ConfigValue[];
}
export type Configuration = Record<string, string[]>;
export type Evidence = Record<string, { value: string; match: string }[]>;

export interface Rules { dimensions: ConfigDimension[]; compiled: { dim: string; value: string; re: RegExp }[]; extractors: { dim: string; re: RegExp }[] }

export async function loadDimensions(db: Db): Promise<ConfigDimension[]> {
  const dims = await db<Omit<ConfigDimension, 'values'>[]>`select * from config_dimension order by sort_order, key`;
  const values = await db<ConfigValue[]>`select * from config_value order by sort_order, value`;
  return dims.map((d) => ({ ...d, values: values.filter((v) => v.dimensionKey === d.key) }));
}

export function compileRules(dimensions: ConfigDimension[]): Rules {
  const compiled: Rules['compiled'] = [];
  for (const d of dimensions) for (const v of d.values) for (const p of v.patterns) compiled.push({ dim: d.key, value: v.value, re: new RegExp(p, 'i') });
  const extractors = dimensions.filter((d) => d.extractPattern).map((d) => ({ dim: d.key, re: new RegExp(d.extractPattern!, 'g') }));
  return { dimensions, compiled, extractors };
}

/** Text, aus dem die Konfiguration eines Zyklus abgeleitet wird. */
export const cycleText = (c: { name: string; environment?: string | null; build?: string | null }) =>
  [c.name, c.environment ?? '', c.build ?? ''].join(' | ');

/** Reine Funktion: erkennt Merkmalswerte in einem Text und belegt jeden Treffer mit der auslösenden Textstelle. */
export function classify(rules: Rules, text: string): { configuration: Configuration; evidence: Evidence } {
  const configuration: Configuration = {};
  const evidence: Evidence = {};
  const add = (dim: string, value: string, match: string) => {
    const list = (configuration[dim] ??= []);
    if (!list.includes(value)) {
      list.push(value);
      (evidence[dim] ??= []).push({ value, match: match.trim() });
    }
  };
  for (const r of rules.compiled) {
    const m = r.re.exec(text);
    if (m) add(r.dim, r.value, m[0]);
  }
  for (const x of rules.extractors) {
    for (const m of text.matchAll(x.re)) if (m[1]) add(x.dim, m[1], m[0]);
  }
  // Werte in der Reihenfolge der Regeln sortieren (stabile Darstellung)
  for (const d of rules.dimensions) {
    const order = d.values.map((v) => v.value);
    configuration[d.key]?.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b));
  }
  return { configuration, evidence };
}

let cache: { at: number; rules: Rules } | null = null;
export async function currentRules(db: Db): Promise<Rules> {
  if (!cache || Date.now() - cache.at > 30_000) cache = { at: Date.now(), rules: compileRules(await loadDimensions(db)) };
  return cache.rules;
}
const invalidate = () => { cache = null; };

/** Konfiguration eines Zyklus automatisch neu bestimmen (nur wenn nicht manuell gesetzt). */
export async function autoClassifyCycle(db: Db, cycleId: string): Promise<void> {
  const [c] = await db<{ name: string; environment: string | null; build: string | null; configurationSource: string }[]>`
    select name, environment, build, configuration_source from test_cycle where id = ${cycleId}`;
  if (!c || c.configurationSource === 'manual') return;
  const { configuration, evidence } = classify(await currentRules(db), cycleText(c));
  await db`update test_cycle set configuration = ${db.json(configuration as never)}, configuration_evidence = ${db.json(evidence as never)}
           where id = ${cycleId}`;
}

/** Reihenfolgeunabhängiger Vergleich (jsonb ordnet Schlüssel selbst). */
const canonical = (c: Configuration) => JSON.stringify(Object.keys(c).sort().map((k) => [k, [...(c[k] ?? [])].sort()]));

export async function reclassifyCycles(db: Db, projectId?: string): Promise<{ total: number; changed: number }> {
  invalidate();
  const rules = await currentRules(db);
  const cycles = await db<{ id: string; name: string; environment: string | null; build: string | null; configuration: Configuration }[]>`
    select id, name, environment, build, configuration from test_cycle
    where configuration_source = 'auto' ${projectId ? db`and project_id = ${projectId}` : db``}`;
  let changed = 0;
  for (const c of cycles) {
    const { configuration, evidence } = classify(rules, cycleText(c));
    if (canonical(configuration) === canonical(c.configuration)) continue;
    await db`update test_cycle set configuration = ${db.json(configuration as never)}, configuration_evidence = ${db.json(evidence as never)} where id = ${c.id}`;
    changed++;
  }
  return { total: cycles.length, changed };
}

export async function setCycleConfiguration(db: Db, cycleId: string, configuration: Configuration | null): Promise<void> {
  if (configuration === null) {
    const r = await db`update test_cycle set configuration_source = 'auto' where id = ${cycleId}`;
    if (r.count === 0) throw notFound('Testzyklus', cycleId);
    await autoClassifyCycle(db, cycleId);
    return;
  }
  const dims = new Set((await loadDimensions(db)).map((d) => d.key));
  for (const k of Object.keys(configuration)) if (!dims.has(k)) throw badRequest(`Unbekanntes Merkmal: ${k}`);
  const clean: Configuration = {};
  for (const [k, v] of Object.entries(configuration)) {
    const values = [...new Set((v ?? []).map((x) => x.trim()).filter(Boolean))];
    if (values.length) clean[k] = values;
  }
  const r = await db`update test_cycle set configuration = ${db.json(clean as never)}, configuration_source = 'manual', configuration_evidence = '{}'
                     where id = ${cycleId}`;
  if (r.count === 0) throw notFound('Testzyklus', cycleId);
}

export async function upsertConfigValue(db: Db, dimensionKey: string, v: { value: string; description?: string | null; patterns: string[]; sortOrder?: number }) {
  for (const p of v.patterns) {
    try {
      new RegExp(p, 'i');
    } catch (e) {
      throw badRequest(`Ungültiger regulärer Ausdruck „${p}“: ${(e as Error).message}`);
    }
  }
  const [row] = await db<ConfigValue[]>`
    insert into config_value(dimension_key, value, description, patterns, sort_order)
    values (${dimensionKey}, ${v.value}, ${v.description ?? null}, ${v.patterns}::text[], ${v.sortOrder ?? 100})
    on conflict (dimension_key, value) do update set description = excluded.description, patterns = excluded.patterns,
      sort_order = coalesce(${v.sortOrder ?? null}, config_value.sort_order)
    returning *`;
  invalidate();
  return row!;
}

export async function deleteConfigValue(db: Db, id: string): Promise<void> {
  const r = await db`delete from config_value where id = ${id}`;
  if (r.count === 0) throw notFound('Merkmalswert', id);
  invalidate();
}

/** Häufigkeit je Merkmalswert (für Verwaltung und Filter). */
export async function configurationCounts(db: Db, projectId?: string, planId?: string) {
  return db<{ dimension: string; value: string; cycles: number }[]>`
    select d.key as dimension, v.value, count(*)::int as cycles
    from test_cycle c, jsonb_each(c.configuration) d(key, vals), jsonb_array_elements_text(d.vals) v(value)
    where true ${projectId ? db`and c.project_id = ${projectId}` : db``} ${planId ? db`and c.plan_id = ${planId}` : db``}
    group by 1, 2 order by 1, 3 desc`;
}

/** Zyklen ohne erkannten Wert in Kern-Merkmalen – Grundlage zum Nachschärfen der Regeln. */
export async function unclassifiedTexts(db: Db, projectId: string | undefined, dimension: string, limit = 100) {
  return db<{ text: string; cycles: number }[]>`
    select coalesce(nullif(c.environment, ''), c.name) as text, count(*)::int as cycles
    from test_cycle c
    where not (c.configuration ? ${dimension}) ${projectId ? db`and c.project_id = ${projectId}` : db``}
    group by 1 order by 2 desc, 1 limit ${limit}`;
}

/** Ergebnisse je Merkmalswert (z. B. Fehlerquote je Datenbank) für ein Projekt bzw. einen Testplan. */
export async function configurationStats(db: Db, projectId: string, planId?: string) {
  return db<{ dimension: string; value: string; cycles: number; byStatus: Record<string, number> }[]>`
    with cyc as (
      select c.id, d.key as dimension, v.value from test_cycle c, jsonb_each(c.configuration) d(key, vals), jsonb_array_elements_text(d.vals) v(value)
      where c.project_id = ${projectId} ${planId ? db`and c.plan_id = ${planId}` : db``}
    ), counts as (
      select dimension, value, count(distinct id)::int as cycles from cyc group by 1, 2
    ), statuses as (
      select dimension, value, jsonb_object_agg(status, n) as by_status from (
        select cyc.dimension, cyc.value, e.status, count(*)::int as n from cyc join test_execution e on e.cycle_id = cyc.id group by 1, 2, 3
      ) x group by 1, 2
    )
    select c.dimension, c.value, c.cycles, coalesce(s.by_status, '{}'::jsonb) as by_status
    from counts c left join statuses s using (dimension, value) order by 1, 2`;
}
