#!/usr/bin/env bash
# Sicherung von Anemo: Datenbank (pg_dump, Custom-Format) + Anhänge (tar) + Prüfsummen.
#
#   tools/backup.sh [ZIELVERZEICHNIS]
#
# Umgebung (Standardwerte für die Compose-Installation):
#   DB_SERVICE=db  DB_NAME=anemo  DB_USER=anemo      Compose-Dienst und Datenbank
#   ATTACHMENT_DIR=.data/attachments                 Anhangsverzeichnis (lokale Installation)
#   ATTACHMENT_VOLUME=anemo_app-data                 alternativ: Docker-Volume des App-Containers (enthält attachments/)
#   SKIP_ATTACHMENTS=1                               nur Datenbank sichern
#   KEEP=14                                          ältere Sicherungen im Zielverzeichnis über diese Anzahl hinaus löschen
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_ROOT="${1:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$TARGET_ROOT/anemo-$STAMP"
DEST_ABS="$(mkdir -p "$DEST" && cd "$DEST" && pwd)"
DB_SERVICE="${DB_SERVICE:-db}"; DB_NAME="${DB_NAME:-anemo}"; DB_USER="${DB_USER:-anemo}"
mkdir -p "$DEST"
umask 077

echo "→ Datenbank $DB_NAME sichern …"
docker compose exec -T "$DB_SERVICE" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner > "$DEST/datenbank.dump"
# Plausibilitätsprüfung: Inhaltsverzeichnis lesbar?
docker compose exec -T "$DB_SERVICE" pg_restore -l < "$DEST/datenbank.dump" > /dev/null

if [ "${SKIP_ATTACHMENTS:-0}" != "1" ]; then
  if [ -n "${ATTACHMENT_VOLUME:-}" ]; then
    echo "→ Anhänge aus Volume $ATTACHMENT_VOLUME sichern …"
    docker run --rm -v "$ATTACHMENT_VOLUME:/data:ro" -v "$(cd "$DEST" && pwd):/out" alpine:3.20 sh -c 'cd /data && tar -cf /out/anhaenge.tar attachments $(ls secret.key 2>/dev/null)'
  else
    DIR="${ATTACHMENT_DIR:-.data/attachments}"
    echo "→ Anhänge aus $DIR sichern …"
    # secret.key gehört dazu: damit sind in der Oberfläche gespeicherte Passwörter/Tokens verschlüsselt
    ( cd "$(dirname "$DIR")" && tar -cf "$DEST_ABS/anhaenge.tar" "$(basename "$DIR")" $(ls secret.key 2>/dev/null) )
  fi
fi

# Prüfsummen über die Sicherungsdateien (nicht über die Prüfsummendatei selbst)
( cd "$DEST" && FILES=$(ls datenbank.dump anhaenge.tar 2>/dev/null || true) && if command -v sha256sum >/dev/null; then sha256sum $FILES; else shasum -a 256 $FILES; fi > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS )
cat > "$DEST/INFO.txt" <<INFO
Anemo-Sicherung $STAMP
Datenbank: $DB_NAME (pg_dump -Fc)
Anhänge:   $([ -f "$DEST/anhaenge.tar" ] && echo "anhaenge.tar" || echo "nicht gesichert")
Wiederherstellen: tools/restore.sh $DEST
INFO
echo "✓ Sicherung: $DEST ($(du -sh "$DEST" | cut -f1))"

if [ -n "${KEEP:-}" ]; then
  ls -1d "$TARGET_ROOT"/anemo-* 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do echo "  alte Sicherung entfernt: $old"; rm -rf "$old"; done
fi
