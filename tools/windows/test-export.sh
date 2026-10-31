#!/usr/bin/env bash
# Ende-zu-Ende-Test für export-zephyr.ps1 + zephyr:load auf dem Entwicklungsrechner.
# Benötigt: Docker, PowerShell 7 (pwsh). Simuliert die Jira-MySQL mit einem MariaDB-Container;
# mysql/mysqldump werden über Wrapper im Container ausgeführt, genau wie das Skript sie unter Windows aufruft.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
SRC=anemo-zephyr-src-test
trap 'docker rm -f $SRC >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

echo "== PowerShell-2.0-Kompatibilität (der Jira-Server läuft mit PowerShell 2.0)"
pwsh -NoProfile -File "$ROOT/tools/windows/check-ps2-compat.ps1" "$ROOT/tools/windows/export-zephyr.ps1"

echo "== Quell-Datenbank (simuliert Jira-MySQL) starten"
docker run -d --name $SRC -e MARIADB_ROOT_PASSWORD=root -e MARIADB_DATABASE=jiradb \
  -e MARIADB_USER=jira -e MARIADB_PASSWORD='geh eim"1' mariadb:11.8 >/dev/null
for _ in $(seq 60); do docker exec $SRC healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 && break; sleep 1; done

docker exec -i $SRC mariadb -uroot -proot jiradb <<'SQL'
CREATE TABLE AO_7DEABF_TESTSTEP (ID INT PRIMARY KEY, ISSUE_ID BIGINT, ORDER_ID INT, STEP LONGTEXT, DATA LONGTEXT, RESULT LONGTEXT) DEFAULT CHARSET=utf8;
CREATE TABLE AO_7DEABF_CYCLE (ID INT PRIMARY KEY, NAME VARCHAR(255), VERSION_ID BIGINT, START_DATE BIGINT, BUILD VARCHAR(255)) DEFAULT CHARSET=utf8;
CREATE TABLE AO_7DEABF_SCHEDULE (ID INT PRIMARY KEY, CYCLE_ID INT, ISSUE_ID BIGINT, STATUS VARCHAR(10), EXECUTED_BY VARCHAR(255), COMMENT LONGTEXT) DEFAULT CHARSET=utf8;
CREATE TABLE AO_7DEABF_ATTACHMENT (ID INT PRIMARY KEY, TYPE VARCHAR(63), ENTITY_ID BIGINT, FILESIZE BIGINT, FILE_NAME VARCHAR(255), CONTENT LONGBLOB) DEFAULT CHARSET=utf8;
CREATE TABLE jiraissue (ID BIGINT PRIMARY KEY, SUMMARY VARCHAR(255));
CREATE TABLE propertyentry (ID DECIMAL(18,0) PRIMARY KEY, ENTITY_NAME VARCHAR(255), ENTITY_ID DECIMAL(18,0), PROPERTY_KEY VARCHAR(255), propertytype DECIMAL(9,0));
CREATE TABLE propertytext (ID DECIMAL(18,0) PRIMARY KEY, propertyvalue LONGTEXT);
CREATE TABLE propertystring (ID DECIMAL(18,0) PRIMARY KEY, propertyvalue TEXT);
INSERT INTO propertyentry VALUES (1, 'jira.properties', 1, 'com.thed.zephyr.je.testExecutionStatus', 6), (2, 'jira.properties', 1, 'com.thed.zephyr.je.stepExecutionStatus', 6), (3, 'jira.properties', 1, 'jira.title', 5);
INSERT INTO propertytext VALUES (1, '[{"id":5,"name":"BESTANDEN MIT MANGEL","color":"#9ACD32"}]'), (2, '[{"id":6,"name":"INVALID","color":"#999"}]');
INSERT INTO propertystring VALUES (3, 'geheimer Jira-Titel');
INSERT INTO AO_7DEABF_TESTSTEP VALUES
 (1, 20001, 1, 'Akte öffnen – „Größe“ prüfen', NULL, 'Akte wird angezeigt'),
 (2, 20001, 2, 'Zeile 1\nZeile 2\twith tab', 'Daten mit ''Hochkomma'' und \\Backslash', 'ß ÄÖÜ € 中文');
INSERT INTO AO_7DEABF_CYCLE VALUES (10, 'Regression 7.3', 10010, 1791100800000, '7.3.0.117'), (11, 'Ad hoc', -1, NULL, NULL);
INSERT INTO AO_7DEABF_SCHEDULE VALUES (100, 10, 20001, '1', 'emusterfrau', 'ok'), (101, 10, 20002, '2', 'mmustermann', NULL), (102, 11, 20001, '-1', NULL, ''), (103, 11, 20003, '1', 'x', 'Klammer ( ) und ), ; INSERT INTO \`x\` VALUES (1);');
INSERT INTO AO_7DEABF_ATTACHMENT VALUES (1, 'SCHEDULE', 100, 11, 'bild.png', UNHEX('89504E470D0A1A0A00FF00')),
  (2, 'TESTSTEPRESULT', 5, 4, 'log mit Leerzeichen.txt', NULL), (3, 'SCHEDULE', 101, 7, 'fehlt.png', NULL);
INSERT INTO jiraissue VALUES (1, 'darf nicht exportiert werden');
SQL

echo "== Wrapper für mysql/mysqldump"
mkdir -p "$WORK/bin" "$WORK/out"
printf '#!/bin/sh\nexec docker exec -i -e MYSQL_PWD %s mariadb "$@"\n' $SRC > "$WORK/bin/mysql"
# --log-error zeigt auf einen Host-Pfad; im Container auf /tmp umlenken.
cat > "$WORK/bin/mysqldump" <<WRAP
#!/bin/bash
args=()
for a in "\$@"; do case "\$a" in --log-error=*) args+=("--log-error=/tmp/mysqldump.log");; *) args+=("\$a");; esac; done
exec docker exec -i -e MYSQL_PWD $SRC mariadb-dump "\${args[@]}"
WRAP
chmod +x "$WORK/bin/mysql" "$WORK/bin/mysqldump"

echo "== Simuliertes Jira-Home mit Zephyr-Anhängen"
JH="$WORK/jira-home"
# Echter Zephyr-Ablageort: data/attachments/<Projekt>/<typ>/<Objekt-ID>/<Anhang-ID>
mkdir -p "$JH/data/attachments/DEMO/schedule/100" "$JH/data/attachments/alt/stepresult/5" "$JH/data/attachments/DEMO/schedule/999"
touch "$JH/dbconfig.xml"
printf '\x89PNG\r\n\x1a\n\x00\xff\x00' > "$JH/data/attachments/DEMO/schedule/100/1"   # 11 Byte, exakt am Zephyr-Ablageort
printf 'LOG!' > "$JH/data/attachments/alt/stepresult/5/2"                                   # 4 Byte, abweichender Ort → Rückfallsuche
printf 'XXXX' > "$JH/data/attachments/DEMO/schedule/999/andere.txt"                         # Attrappe gleicher Größe

echo "== export-zephyr.ps1"
ANEMO_EXPORT_PWD='geh eim"1' pwsh -NoProfile -File "$ROOT/tools/windows/export-zephyr.ps1" \
  -MySqlBin "$WORK/bin" -OutDir "$WORK/out" -JiraHome "$JH" -PasswordFromEnvironment

MANIFEST="$(ls "$WORK"/out/*.manifest.json)"
grep -q '"AO_7DEABF_TESTSTEP": 2' "$MANIFEST"
if gunzip -c "$WORK"/out/*.sql.gz | grep -q jiraissue; then echo "FEHLER: Nicht-Zephyr-Tabelle exportiert"; exit 1; fi
if gunzip -c "$WORK"/out/*.sql.gz | grep -q 'geheimer Jira-Titel'; then echo "FEHLER: Nicht-Zephyr-Eigenschaft exportiert"; exit 1; fi
grep -q '"propertyentry": 2' "$MANIFEST" && grep -q '"propertytext": 2' "$MANIFEST" && grep -q '"propertystring": 0' "$MANIFEST" \
  || { echo "FEHLER: Zephyr-Eigenschaften fehlen im Manifest"; cat "$MANIFEST"; exit 1; }
gunzip -c "$WORK"/out/*.sql.gz | grep -q 'BESTANDEN MIT MANGEL' || { echo "FEHLER: Statusdefinition fehlt im Dump"; exit 1; }

echo "== Anhänge prüfen"
TGZ="$(ls "$WORK"/out/*.attachments.tar.gz)"
tar -tzf "$TGZ" | sort | tr '\n' ' '; echo
[ "$(tar -xzOf "$TGZ" attachments/1 | xxd -p)" = "89504e470d0a1a0a00ff00" ] || { echo "FEHLER: Anhang 1 (bild.png) falsch"; exit 1; }
[ "$(tar -xzOf "$TGZ" attachments/2)" = "LOG!" ] || { echo "FEHLER: Anhang 2 falsch (Attrappe?)"; exit 1; }
tar -xzOf "$TGZ" index.json | grep -q '"log mit Leerzeichen.txt"' || { echo "FEHLER: Dateiname fehlt im index.json"; exit 1; }
tar -xzOf "$TGZ" index.json | node -e 'const i=JSON.parse(require("fs").readFileSync(0,"utf8")); const m=Object.fromEntries(i.map(e=>[e.id,e.match])); if (m["1"]!=="exact"||m["2"]!=="heuristic") { console.error("FEHLER: match-Kennzeichnung", m); process.exit(1) }'
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MANIFEST" || { echo "FEHLER: Manifest ist kein gültiges JSON"; exit 1; }
grep -q '"fehlt.png"' "$MANIFEST" || { echo "FEHLER: fehlender Anhang nicht im Manifest"; exit 1; }

echo "== zephyr:load (erwartet FAILED wegen fehlendem Anhang 3)"
set +e
(cd "$ROOT" && node server/scripts/load-zephyr-dump.ts --manifest "$MANIFEST" --database zephyr_e2e_test) | tee "$WORK/load.log"
status=${PIPESTATUS[0]}
set -e
[ "$status" = "1" ] && grep -q 'Anhänge: 2/3 im Archiv – 1 fehlen: 3 fehlt.png' "$WORK/load.log" \
  || { echo "FEHLER: Loader hätte den fehlenden Anhang melden müssen (Exit $status)"; exit 1; }

echo "== Inhalte byte-genau vergleichen"
q='SELECT PROPERTY_KEY FROM propertyentry WHERE PROPERTY_KEY LIKE "%zephyr%" ORDER BY ID; SELECT ID, HEX(STEP), HEX(IFNULL(DATA,"<NULL>")), HEX(RESULT) FROM AO_7DEABF_TESTSTEP ORDER BY ID; SELECT HEX(CONTENT) FROM AO_7DEABF_ATTACHMENT; SELECT ID, IFNULL(COMMENT,"<NULL>") FROM AO_7DEABF_SCHEDULE ORDER BY ID;'
src=$(docker exec $SRC mariadb -uroot -proot --batch jiradb -e "$q")
dst=$(cd "$ROOT" && docker compose --profile zephyr exec -T zephyr-db mariadb -uroot -pzephyr --batch zephyr_e2e_test -e "$q")
[ "$src" = "$dst" ] || { echo "FEHLER: Inhalte weichen ab"; diff <(echo "$src") <(echo "$dst"); exit 1; }
(cd "$ROOT" && docker compose --profile zephyr exec -T zephyr-db mariadb -uroot -pzephyr -e 'DROP DATABASE zephyr_e2e_test')
echo "== OK: Export, Übertragung und Import verlustfrei"
