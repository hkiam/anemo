-- OIDC: ID-Token zur Sitzung, damit die Abmeldung beim Anbieter ohne Rückfrage erfolgt (id_token_hint).
alter table user_session add column id_token text;
