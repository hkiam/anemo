import postgres from 'postgres';

/**
 * Datenbankzugriff. Spalten werden automatisch zwischen snake_case (SQL) und camelCase (TS) umgesetzt.
 *
 * Konvention: Fachfunktionen erhalten ein {@link Db} und öffnen selbst keine Transaktion. Transaktionen
 * werden am Rand (HTTP-Route, Import-Lauf) mit {@link inTx} geöffnet.
 */
export type Db = postgres.Sql<{}>;

/**
 * Zeitlimit je SQL-Anweisung für Anfragen (Sicherheitsreview Teil 2, Befund 9): Eine teure Abfrage (z. B. über die
 * Abfragesprache) belegt eine Verbindung des Pools höchstens so lange. Einstellbar per `ANEMO_DB_STATEMENT_TIMEOUT_MS`
 * (Standard 30 000 ms, 0 = kein Limit). Lange Läufe (Schemamigrationen, Datenübernahme, Sicherung) schalten es mit
 * {@link withoutStatementTimeout} bzw. `connect(url, { connection: { statement_timeout: 0 } })` ab.
 */
export function statementTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.ANEMO_DB_STATEMENT_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 30_000;
}

export function connect(url: string, options: postgres.Options<{}> = {}): Db {
  return postgres(url, {
    // Nur Spaltennamen umsetzen – postgres.camel würde auch Schlüssel in jsonb-Werten verändern
    // (z. B. migrierte Custom Fields) und damit Daten verfälschen.
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
    onnotice: () => {},
    max: 10,
    ...options,
    connection: { statement_timeout: statementTimeoutMs(), ...options.connection },
  });
}

/** Innerhalb einer Transaktion: Zeitlimit für die restliche Transaktion aufheben (Migrationen, Übernahme, Sicherung). */
export async function withoutStatementTimeout(tx: Db): Promise<void> {
  await tx`set local statement_timeout = 0`;
}

export async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  // TransactionSql bietet dieselbe Abfrage-API wie Sql; die Fachfunktionen brauchen nur diese.
  return (await db.begin((tx) => fn(tx as unknown as Db))) as T;
}
