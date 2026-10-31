-- Ein Test darf in einem Zyklus mehrfach ausgeführt werden (Wiederholungsläufe). Zephyr kennt das im
-- Ad-hoc-Bereich (538 Ausführungen in 112 Gruppen); die frühere Eindeutigkeit hat solche Ausführungen
-- zusammengelegt. Beim Einplanen über die Oberfläche verhindert die Anwendung weiterhin Doppelte.
alter table test_execution drop constraint test_execution_cycle_id_test_case_id_key;
create index test_execution_cycle_case_idx on test_execution(cycle_id, test_case_id);
