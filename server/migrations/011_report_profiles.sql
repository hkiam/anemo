-- Berichtsprofile (ADR-0016): anpassbare Testberichte in Anlehnung an ISO/IEC/IEEE 29119-3.
create table report_profile (
  id          uuid primary key default uuidv7(),
  name        text not null,
  options     jsonb not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index report_profile_default_idx on report_profile (is_default) where is_default;

insert into report_profile(name, is_default, options) values
('Standard', true, '{
  "organization": "",
  "accentColor": "#3451b2",
  "footer": "Vertraulich – nur für den bestimmungsgemäßen Gebrauch",
  "standardNote": true,
  "signoffRoles": ["Testmanagement", "Projektleitung", "Auftraggeber"],
  "sections": { "summary": true, "environment": true, "executions": true, "steps": false, "comments": true,
                "defects": true, "openItems": true, "evidence": true, "signoff": true }
}'),
('Ausführlich (mit Schritten)', false, '{
  "organization": "",
  "accentColor": "#3451b2",
  "footer": "Vertraulich – nur für den bestimmungsgemäßen Gebrauch",
  "standardNote": true,
  "signoffRoles": ["Testmanagement", "Projektleitung"],
  "sections": { "summary": true, "environment": true, "executions": true, "steps": true, "comments": true,
                "defects": true, "openItems": true, "evidence": true, "signoff": true }
}');
