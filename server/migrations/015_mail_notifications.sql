-- E-Mail-Benachrichtigungen (ADR-0020): Abonnements je Benutzer, Lesezeiger des Mail-Versands.
create table user_notification (
  user_id  uuid not null references app_user(id) on delete cascade,
  kind     text not null check (kind in ('assigned', 'retest', 'failed_own')),
  primary key (user_id, kind)
);
-- Voreinstellung für bestehende Benutzer: Zuweisungen und Nachtests
insert into user_notification(user_id, kind) select id, k from app_user, unnest(array['assigned', 'retest']) k;

create table mail_state (
  id               integer primary key default 1 check (id = 1),
  cursor_seq       bigint not null,
  failures         integer not null default 0,
  next_attempt_at  timestamptz,
  last_error       text,
  last_sent_at     timestamptz
);
insert into mail_state(cursor_seq) select coalesce(max(seq), 0) from domain_event;
