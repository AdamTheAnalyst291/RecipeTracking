#!/usr/bin/env bash
# Runs `dbt build` for real against a throwaway SQL Server (card W1). It makes a scratch
# database, applies the app's migrations, loads warehouse/fixtures/fixture-data.sql, and
# builds as a login that has only the grants in packages/db/sql/warehouse-builder.sql, which
# proves they are enough. Then it breaks one row and checks that the tests catch it.
#
#   SQLCMD='sqlcmd -C -S localhost,1433 -U sa -P ...' SQL_SERVER=localhost SQL_PORT=1433 \
#     bash warehouse/scripts/fixture-build.sh
#
# SQLCMD runs T-SQL as the server admin (the script adds -I, QUOTED_IDENTIFIER ON, which
# the migrations' filtered indexes need). In CI it is the sqlcmd inside the SQL Server
# service container (docker exec). SQL_SERVER and SQL_PORT are where dbt reaches the same
# server. DBT is the dbt command (default: dbt on PATH); SQL_ODBC_DRIVER overrides the
# ODBC driver name (default: ODBC Driver 18 for SQL Server).
set -euo pipefail

: "${SQLCMD:?Set SQLCMD to a sqlcmd command signed in as the test server admin}"
: "${SQL_SERVER:?Set SQL_SERVER to the test server host dbt connects to}"
read -ra sqlcmd <<< "$SQLCMD"
read -ra dbt <<< "${DBT:-dbt}"

here="$(cd "$(dirname "$0")" && pwd)"
warehouse="$here/.."
root="$warehouse/.."
suffix="$(date +%s)$RANDOM"
db="warehouse_test_$suffix"
builder="warehouse_builder_$suffix"
builder_password="Builder_${RANDOM}${RANDOM}_x!"

q() { # q <database> <T-SQL>: run as admin, print bare results
  "${sqlcmd[@]}" -I -b -h -1 -W -d "$1" -Q "SET NOCOUNT ON; $2"
}

cleanup() {
  q master "
    IF DB_ID('$db') IS NOT NULL BEGIN ALTER DATABASE [$db] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$db]; END;
    IF SUSER_ID('$builder') IS NOT NULL DROP LOGIN [$builder];" > /dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL $1"; exit 1; }
ok() { echo "ok   $1"; }

echo "Creating $db and applying the migrations"
q master "CREATE DATABASE [$db]" > /dev/null
for m in "$root"/packages/db/migrations/*.sql; do
  # As packages/db's runMigrations does: each file is one batch with XACT_ABORT on.
  "${sqlcmd[@]}" -I -b -d "$db" -Q "SET XACT_ABORT ON; $(cat "$m")" > /dev/null || fail "migration $(basename "$m") didn't apply"
done
ok "the migrations apply"

"${sqlcmd[@]}" -I -b -d "$db" -Q "$(cat "$warehouse/fixtures/fixture-data.sql")" > /dev/null
ok "the fixture data loads"

echo "Creating $builder with only the warehouse builder grants"
q master "CREATE LOGIN [$builder] WITH PASSWORD = '$builder_password', CHECK_POLICY = OFF" > /dev/null
q "$db" "CREATE USER [$builder] FOR LOGIN [$builder]" > /dev/null
grants="$(cat "$root/packages/db/sql/warehouse-builder.sql")"
"${sqlcmd[@]}" -I -b -d "$db" -v WAREHOUSE_BUILDER="$builder" -Q "$grants" > /dev/null
"${sqlcmd[@]}" -I -b -d "$db" -v WAREHOUSE_BUILDER="$builder" -Q "$grants" > /dev/null
ok "the grants apply, and can run again"

export SQL_DATABASE="$db" SQL_USER="$builder" DBT_ENV_SECRET_SQL_PASSWORD="$builder_password"
run_dbt() {
  (cd "$warehouse" && "${dbt[@]}" --no-use-colors "$@" --profiles-dir . --target fixture --no-version-check)
}

echo "dbt build as $builder"
run_dbt build || fail "dbt build failed against the fixtures"
ok "dbt build passes against the fixtures"

views=$(q "$db" "SELECT COUNT(*) FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id WHERE s.name = 'marts' AND v.name LIKE 'stg[_]%'")
models=$(find "$warehouse/models/staging" -name 'stg_*.sql' | wc -l)
[ "$views" -eq "$models" ] || fail "expected $models staging views in marts, found $views"
ok "all $models staging views are in marts"

outside=$(q "$db" "SELECT COUNT(*) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name <> 'marts' AND o.is_ms_shipped = 0 AND o.type IN ('U', 'V') AND o.name LIKE '%stg[_]%'")
[ "$outside" -eq 0 ] || fail "dbt built $outside objects outside marts"
ok "nothing was built outside marts"

[ "$(q "$db" "SELECT COUNT(*) FROM marts.stg_money_splits")" -eq 2 ] || fail "stg_money_splits should show the fixture's 2 splits"
ok "the staging views read the fixture rows"

echo "Breaking a split so it no longer adds up"
q "$db" "UPDATE money_split SET amount_cents = -2400 WHERE position = 2" > /dev/null
if run_dbt test --select assert_splits_add_up_to_their_transaction > /dev/null; then
  fail "the tests should catch splits that don't add up"
fi
ok "the tests catch bad data"

echo "All passed"
