-- Review Teil 3 (Befund 21): Indizes für große Bestände.
-- Verwendung von Bausteinen der Schrittbibliothek: steps @> '[{"blockId": …}]' über alle aktuellen Versionen.
create index if not exists test_case_version_steps_gin on test_case_version using gin (steps jsonb_path_ops);
-- Ergebnisverlauf nach Zeitpunkt (Teststatusbericht, Burn-down, Excel-Rundlauf-Stand).
create index if not exists execution_result_recorded_idx on execution_result (recorded_at);
