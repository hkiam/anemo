-- PostgreSQL kann NUL-Zeichen (U+0000) weder in jsonb noch in text speichern. Enthält ein Quellobjekt
-- solche Zeichen, steht in payload eine durchsuchbare Fassung (NUL → U+FFFD) und in payload_text das
-- exakte Original als JSON-Text (dort ist NUL als \u0000 escaped und damit speicherbar).
alter table source_record add column payload_text text;
