#!/usr/bin/env bash
# Wiederherstellung einer Sicherung aus tools/backup.sh.
#
#   CONFIRM=ja tools/restore.sh backups/anemo-20261011-120000
#
# Ersetzt den Inhalt der Datenbank DB_NAME und der Anhänge. Vorher Anwendung stoppen (docker compose stop app).
# Umgebung wie bei backup.sh; DB_NAME=anemo_test stellt in eine andere Datenbank wieder her (wird angelegt).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?Pfad zur Sicherung angeben}"
DB_SERVICE="${DB_SERVICE:-db}"; DB_NAME="${DB_NAME:-anemo}"; DB_USER="${DB_USER:-anemo}"
[ "${CONFIRM:-}" = "ja" ] || { echo "Abbruch: Wiederherstellung überschreibt $DB_NAME und Anhänge. Mit CONFIRM=ja bestätigen."; exit 1; }

echo "→ Prüfsummen prüfen …"
( cd "$SRC" && if command -v sha256sum >/dev/null; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi )

echo "→ Datenbank $DB_NAME wiederherstellen …"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "select 1 from pg_database where datname = '$DB_NAME'" -t | grep -q 1 \
  || docker compose exec -T "$DB_SERVICE" createdb -U "$DB_USER" "$DB_NAME"
docker compose exec -T "$DB_SERVICE" pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner --single-transaction < "$SRC/datenbank.dump"

if [ -f "$SRC/anhaenge.tar" ] && [ "${SKIP_ATTACHMENTS:-0}" != "1" ]; then
  if [ -n "${ATTACHMENT_VOLUME:-}" ]; then
    echo "→ Anhänge in Volume $ATTACHMENT_VOLUME wiederherstellen …"
    docker run --rm -v "$ATTACHMENT_VOLUME:/data" -v "$(cd "$SRC" && pwd):/in:ro" alpine:3.20 sh -c 'rm -rf /data/attachments && tar -C /data -xf /in/anhaenge.tar'
  else
    DIR="${ATTACHMENT_DIR:-.data/attachments}"
    echo "→ Anhänge nach $DIR wiederherstellen …"
    rm -rf "$DIR" && mkdir -p "$(dirname "$DIR")" && tar -C "$(dirname "$DIR")" -xf "$SRC/anhaenge.tar"
  fi
fi
echo "✓ Wiederhergestellt aus $SRC – Anwendung starten (docker compose start app); Migrationen laufen beim Start automatisch."
