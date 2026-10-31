-- Rückmeldung aus der Nutzung (Mobilprojekt): dokumentierte bekannte Fehler und Gerätematrix.

-- „Fehlgeschlagen (bekannt)“: eigener Ergebnisstatus der Kategorie KNOWN_FAILURE. Er braucht einen Verweis auf ein
-- Ticket oder einen Befund, blockiert die Freigabeempfehlung nicht und wird als Restrisiko getrennt ausgewiesen.
alter table execution_status drop constraint execution_status_category_check;
alter table execution_status add constraint execution_status_category_check
  check (category in ('OPEN', 'IN_PROGRESS', 'PASSED', 'PASSED_WITH_ISSUES', 'KNOWN_FAILURE', 'FAILED', 'BLOCKED', 'INVALID'));
insert into execution_status(code, name, color, is_final, sort_order, category, applies_to, active, description)
values ('FAIL_KNOWN', 'Fehlgeschlagen (bekannt)', '#B5651D', true, 3, 'KNOWN_FAILURE', 'both', true,
  'Dokumentierter bekannter Fehler (Verweis auf Ticket oder Befund nötig) – blockiert die Freigabe nicht, wird als Restrisiko geführt')
on conflict (code) do nothing;

-- Konfigurationsachse „Gerät“ (z. B. iPad, iPhone) – je Zyklus gesetzt, im Cockpit als Matrix ausgewertet
insert into config_dimension(key, name, description, sort_order)
values ('device', 'Gerät', 'Endgerät bzw. Gerätetyp, z. B. iPad, iPhone, Tablet', 8)
on conflict (key) do nothing;
