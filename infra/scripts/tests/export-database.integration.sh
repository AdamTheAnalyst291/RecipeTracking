#!/usr/bin/env bash
# Runs export-database.sh for real against a throwaway SQL Server, then restores the export
# into a scratch database and checks it matches (card S2). Only blob storage is faked: the
# fake `az` puts "uploads" in a local folder. The export signs in as a login that has just
# the grants in packages/db/sql/backup-reader.sql, which proves they're enough and that
# they can't write.
#
#   KITCHEN_TEST_SQL='Server=localhost,1433;User Id=sa;Password=...;TrustServerCertificate=true' \
#   SQLCMD='sqlcmd -C -S localhost -U sa -P ...' \
#     bash infra/scripts/tests/export-database.integration.sh
#
# SQLCMD runs T-SQL as the server admin. In CI it is the sqlcmd inside the SQL Server
# service container (docker exec). SqlPackage must be on PATH, or set SQLPACKAGE.
set -euo pipefail

: "${KITCHEN_TEST_SQL:?Set KITCHEN_TEST_SQL to an admin connection string for the test server}"
: "${SQLCMD:?Set SQLCMD to a sqlcmd command signed in as the test server admin}"
read -ra sqlcmd <<< "$SQLCMD"
read -ra sqlpackage <<< "${SQLPACKAGE:-sqlpackage}"

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=fake-az-storage.sh
source "$here/fake-az-storage.sh"
grants="$here/../../../packages/db/sql/backup-reader.sql"
suffix="$(date +%s)$RANDOM"
db="export_test_$suffix"
restored="${db}_restored"
reader="backup_reader_$suffix"
reader_password="Reader_${RANDOM}${RANDOM}_x!"
server=$(grep -oE '(Server|Data Source)=[^;]+' <<< "$KITCHEN_TEST_SQL")

work="$(mktemp -d)"
mkdir -p "$work/bin" "$work/container"

q() { # q <database> <T-SQL>: run as admin, print bare results
  "${sqlcmd[@]}" -b -h -1 -W -d "$1" -Q "SET NOCOUNT ON; $2"
}

cleanup() {
  q master "
    IF DB_ID('$db') IS NOT NULL BEGIN ALTER DATABASE [$db] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$db]; END;
    IF DB_ID('$restored') IS NOT NULL BEGIN ALTER DATABASE [$restored] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$restored]; END;
    IF SUSER_ID('$reader') IS NOT NULL DROP LOGIN [$reader];" > /dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL $1"; exit 1; }
ok() { echo "ok   $1"; }

echo "Creating $db with a little of everything an export must carry"
q master "CREATE DATABASE [$db]" > /dev/null
q "$db" "
  CREATE TABLE household (
    id INT IDENTITY CONSTRAINT pk_household PRIMARY KEY,
    name NVARCHAR(100) NOT NULL,
    created_at DATETIME2(0) NOT NULL CONSTRAINT df_household_created DEFAULT SYSUTCDATETIME());
  CREATE TABLE recipe (
    id INT IDENTITY CONSTRAINT pk_recipe PRIMARY KEY,
    household_id INT NOT NULL CONSTRAINT fk_recipe_household REFERENCES household (id),
    name NVARCHAR(200) NOT NULL,
    servings DECIMAL(9, 3) NULL,
    notes NVARCHAR(MAX) NULL);
  CREATE INDEX ix_recipe_household ON recipe (household_id);
" > /dev/null
q "$db" "EXEC('CREATE VIEW recipe_count AS SELECT household_id, COUNT(*) AS n FROM recipe GROUP BY household_id')" > /dev/null
q "$db" "
  INSERT household (name) VALUES (N'Home');
  INSERT recipe (household_id, name, servings, notes) VALUES
    (1, N'Crème brûlée', 4, N'Torch the sugar'),
    (1, N'Pad kra pao กะเพรา', 2.5, NULL),
    (1, N'Bread', NULL, REPLICATE(CAST(N'knead ' AS NVARCHAR(MAX)), 2000));
" > /dev/null

echo "Creating $reader with only the backup reader grants"
q master "CREATE LOGIN [$reader] WITH PASSWORD = '$reader_password', CHECK_POLICY = OFF" > /dev/null
q "$db" "CREATE USER [$reader] FOR LOGIN [$reader]" > /dev/null
"${sqlcmd[@]}" -b -d "$db" -v BACKUP_READER="$reader" -Q "$(cat "$grants")" > /dev/null
ok "the grants file applies"
"${sqlcmd[@]}" -b -d "$db" -v BACKUP_READER="$reader" -Q "$(cat "$grants")" > /dev/null
ok "the grants file can run again"

if q "$db" "EXECUTE AS USER = '$reader'; INSERT household (name) VALUES (N'Intruder'); REVERT;" > /dev/null 2>&1; then
  fail "the backup reader must not be able to write"
fi
ok "the backup reader can't write"

# Fake blob storage: the container is a folder.
make_fake_az "$work/bin" "$work/container" "$work/az-calls"

echo "Exporting as $reader"
PATH="$work/bin:$PATH" SQL_SERVER=localhost SQL_DATABASE="$db" BACKUP_STORAGE_ACCOUNT=local \
  SQL_CONNECTION_STRING="$server;Database=$db;User Id=$reader;Password=$reader_password;TrustServerCertificate=true" \
  EXPORT_ATTEMPTS=1 WORK_DIR="$work/export" bash "$here/../export-database.sh"
bacpac=$(find "$work/container/$db" -name "$db-*.bacpac" | head -1)
[ -n "$bacpac" ] || fail "export-database.sh uploaded no bacpac"
ok "the export ran as the backup reader and was uploaded"

echo "Restoring it into $restored"
"${sqlpackage[@]}" /Action:Import /Quiet:True "/SourceFile:$bacpac" \
  "/TargetConnectionString:$KITCHEN_TEST_SQL;Database=$restored"
ok "the export imports into a new database"

summary="SELECT
  (SELECT COUNT(*) FROM household), (SELECT COUNT(*) FROM recipe),
  (SELECT CHECKSUM_AGG(CHECKSUM(id, household_id, name, servings, notes)) FROM recipe),
  (SELECT n FROM recipe_count WHERE household_id = 1),
  (SELECT COUNT(*) FROM sys.foreign_keys WHERE name = 'fk_recipe_household'),
  (SELECT COUNT(*) FROM sys.indexes WHERE name = 'ix_recipe_household')"
before=$(q "$db" "$summary")
after=$(q "$restored" "$summary")
echo "Original: $before"
echo "Restored: $after"
[ "$before" = "$after" ] || fail "the restored database doesn't match the original"
ok "the restored database has the same rows, view, foreign key and index"

[ "$(q "$restored" "SELECT COUNT(*) FROM recipe WHERE name = N'Crème brûlée'")" = 1 ] || fail "Unicode text didn't survive"
ok "Unicode text survives"

next_id=$(q "$restored" "INSERT household (name) VALUES (N'Next'); SELECT SCOPE_IDENTITY()")
[ "$next_id" = 2 ] || fail "identity should carry on from 1, got $next_id"
ok "identity columns carry on where they left off"

echo "All passed"
