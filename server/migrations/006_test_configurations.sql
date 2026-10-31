-- Testkonfigurationen: Umgebungsangaben (bisher Freitext wie "SQL/ORA", "SC - ORADB") als strukturierte Merkmale.
-- Regeln sind Daten (bearbeitbar über die API); der Originaltext der Zyklen bleibt unverändert erhalten.

create table config_dimension (
  key            text primary key,
  name           text not null,
  description    text,
  sort_order     integer not null default 0,
  -- optionales Muster mit Gruppe 1 = Wert (für offene Wertebereiche wie Testsysteme "SYSTEST_Q124")
  extract_pattern text
);

create table config_value (
  id             uuid primary key default uuidv7(),
  dimension_key  text not null references config_dimension(key) on delete cascade,
  value          text not null,
  description    text,
  -- reguläre Ausdrücke (ohne Groß-/Kleinschreibung), geprüft gegen Zyklusname + Umgebung + Build
  patterns       text[] not null default '{}',
  sort_order     integer not null default 0,
  unique (dimension_key, value)
);

alter table test_cycle
  add column configuration jsonb not null default '{}',
  add column configuration_source text not null default 'auto' check (configuration_source in ('auto', 'manual')),
  add column configuration_evidence jsonb not null default '{}';
create index test_cycle_configuration_idx on test_cycle using gin (configuration jsonb_path_ops);

-- Grundregeln, abgeleitet aus dem migrierten Bestand (Zyklusnamen und Umgebungsangaben)
insert into config_dimension(key, name, description, sort_order, extract_pattern) values
  ('database',  'Datenbank',          'Datenbanksystem des Backends', 1, null),
  ('client',    'Client',             'Getesteter Client bzw. Zugang', 2, null),
  ('os',        'Betriebssystem',     'Betriebssystem des Clients', 3, null),
  ('office',    'Office/Dokumente',   'Office-Paket bzw. Dokumentenanwendung', 4, null),
  ('browser',   'Browser',            'Browser (Weboberfläche)', 5, null),
  ('system',    'Testsystem/Mandant', 'Testinstanz bzw. Mandant (automatisch aus Kennungen wie SYSTEST_Q124)', 6,
                '(?:^|[^A-Za-z0-9])(SYS[_A-Z][A-Z0-9_]{2,})(?![a-z])'),
  ('test_type', 'Testart',            'Art des Testlaufs', 7, null);

insert into config_value(dimension_key, value, description, patterns, sort_order) values
  ('database', 'Oracle',      null, array['(^|[^a-z])(ora|oracle|oracledb|oracle-dbms)([^a-z]|$)', 'oradb', 'orafs'], 1),
  ('database', 'SQL Server',  null, array['sqlfs', 'sql[- ]?server', 'mssql', 'ms-sql', '(^|[^a-z])sql([^a-z]|$)'], 2),
  ('database', 'PostgreSQL',  null, array['postgres', 'pgsql'], 3),
  ('client', 'Desktop',        null, array['desktop', 'fat ?client'], 1),
  ('client', 'Web',            null, array['web ?client', 'web ?ui', 'weboberfl'], 2),
  ('client', 'Mobil/App',      null, array['mobile', '(^|[^a-z])ios([^a-z]|$)', 'android', 'mobileclient'], 4),
  ('client', 'Administration', null, array['administration', 'admin ?client'], 5),
  ('client', 'API',            'Programmierschnittstelle', array['(^|[^a-z])api([^a-z]|$)', 'rest ?api'], 6),
  ('os', 'Windows 7',  null, array['win(dows)? ?7([^0-9]|$)'], 1),
  ('os', 'Windows 10', null, array['win(dows)? ?10'], 2),
  ('os', 'Windows 11', null, array['win(dows)? ?11'], 3),
  ('os', 'Linux',      null, array['linux'], 4),
  ('os', 'iOS',        null, array['(^|[^a-z])ios([^a-z]|$)'], 5),
  ('os', 'Android',    null, array['android'], 6),
  ('office', 'MS Office',   null, array['ms ?office', 'office ?365', '(^|[^a-z])(word|outlook|excel)([^a-z]|$)'], 1),
  ('office', 'LibreOffice', null, array['libre ?office', '(^|[^a-z])lo ?\d'], 2),
  ('office', 'Adobe',       null, array['adobe', 'acrobat'], 3),
  ('browser', 'Edge',    null, array['edge'], 1),
  ('browser', 'Chrome',  null, array['chrome'], 2),
  ('browser', 'Firefox', null, array['firefox'], 3),
  ('test_type', 'Systemtest',          null, array['(^|[^a-z])st([^a-z]|$)', 'systemtest'], 1),
  ('test_type', 'Regressionstest',     null, array['regression', '(^|[^a-z])reg[_ ]'], 2),
  ('test_type', 'Freigabetest',        null, array['freigabe'], 3),
  ('test_type', 'Hotfix-Test',         null, array['(^|[^a-z])hf[_ -]?\d', 'hotfix', '(^|[^a-z])hf\+'], 4),
  ('test_type', 'Installation/Update', null, array['install', 'update', 'migration'], 5),
  ('test_type', 'Performance',         null, array['performance', 'lasttest'], 6);
