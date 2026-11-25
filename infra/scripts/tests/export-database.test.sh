#!/usr/bin/env bash
# Tests for export-database.sh with fake `az` and `sqlpackage`: nothing leaves the machine.
#   bash infra/scripts/tests/export-database.test.sh
# export-database.integration.sh runs the real SqlPackage against a real SQL Server.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../export-database.sh"
failures=0
# shellcheck source=fake-az-storage.sh
source "$here/fake-az-storage.sh"

# setup <existing export names, space-separated> <sqlpackage failures before success> [bad]
# The fake storage container is a folder; the fake `az` lists, uploads and deletes in it.
setup() {
  work="$(mktemp -d)"
  mkdir -p "$work/bin" "$work/container"
  for name in $1; do mkdir -p "$work/container/$(dirname "$name")"; echo old > "$work/container/$name"; done
  echo "$2" > "$work/sqlpackage_failures"
  echo "${3:-good}" > "$work/bacpac_kind"
  : > "$work/calls"

  make_fake_az "$work/bin" "$work/container" "$work/calls" "$work/fail_upload"

  # Writes a bacpac (a zip, so it starts with PK) unless told to fail or write junk.
  cat > "$work/bin/sqlpackage" <<EOF
#!/usr/bin/env bash
work="$work"
EOF
  cat >> "$work/bin/sqlpackage" <<'EOF'
echo "sqlpackage $*" >> "$work/calls"
left=$(cat "$work/sqlpackage_failures")
if [ "$left" -gt 0 ]; then
  echo $((left - 1)) > "$work/sqlpackage_failures"
  echo "*** Error 40613: Database is not currently available."; exit 1
fi
for a in "$@"; do case "$a" in /TargetFile:*) target="${a#/TargetFile:}" ;; esac; done
if [ "$(cat "$work/bacpac_kind")" = bad ]; then echo "not a zip" > "$target"; else printf 'PK\003\004fake bacpac' > "$target"; fi
EOF
  chmod +x "$work/bin/sqlpackage"
}

run_script() {
  env PATH="$work/bin:$PATH" SQL_SERVER=sql-test.database.windows.net SQL_DATABASE=sqldb-kitchen-app \
    BACKUP_STORAGE_ACCOUNT=stkitchenbaktest BACKUP_CONTAINER=database-exports \
    EXPORT_ATTEMPTS=3 EXPORT_RETRY_DELAY=0 WORK_DIR="$work/tmp" "$@" \
    bash "$script" > "$work/output" 2>&1
}

exports() { (cd "$work/container" && find . -type f | sed 's|^\./||' | sort); }

check() { # check <name> <condition result>
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$work/output"; failures=$((failures + 1)); fi
}

weeks() { # weeks <n>: names of n older weekly exports, oldest first
  for i in $(seq 1 "$1"); do printf 'sqldb-kitchen-app/sqldb-kitchen-app-202601%02dT060000Z.bacpac ' "$i"; done
}

setup "" 0
run_script
code=$?
[ "$code" -eq 0 ] && [ "$(exports | wc -l)" -eq 1 ] \
  && exports | grep -Eq '^sqldb-kitchen-app/sqldb-kitchen-app-[0-9]{8}T[0-9]{6}Z\.bacpac$'
check "uploads one export, named for the database and the UTC time" $?

setup "" 0
run_script
grep -q "/AccessToken:fake-sql-token" "$work/calls" && grep -q "/SourceServerName:sql-test.database.windows.net" "$work/calls" \
  && grep -q "/SourceDatabaseName:sqldb-kitchen-app" "$work/calls" && grep -q -- "--resource https://database.windows.net/" "$work/calls"
check "exports with an Entra access token for Azure SQL, never a password" $?

setup "" 0
run_script
grep -q "storage blob upload" "$work/calls" && ! grep "storage blob" "$work/calls" | grep -qv -- "--auth-mode login"
check "uses Entra sign-in for every storage call, never an account key" $?

setup "$(weeks 9)" 0
run_script
code=$?
[ "$code" -eq 0 ] && [ "$(exports | wc -l)" -eq 8 ] \
  && ! exports | grep -q 'app-20260101T' && ! exports | grep -q 'app-20260102T' && exports | grep -q 'app-20260103T'
check "keeps the newest 8 and deletes the older ones" $?

setup "$(weeks 5)" 0
run_script
code=$?
[ "$code" -eq 0 ] && [ "$(exports | wc -l)" -eq 6 ] && ! grep -q "blob delete" "$work/calls"
check "deletes nothing while there are 8 or fewer" $?

setup "$(weeks 9) other/sqldb-other-20250101T060000Z.bacpac" 0
run_script
exports | grep -q '^other/sqldb-other-20250101T060000Z.bacpac$'
check "never touches blobs outside this database's folder" $?

setup "$(weeks 9)" 0
run_script BACKUP_KEEP=3
[ "$(exports | wc -l)" -eq 3 ]
check "BACKUP_KEEP changes how many are kept" $?

setup "" 2
run_script
code=$?
[ "$code" -eq 0 ] && [ "$(grep -c '^sqlpackage' "$work/calls")" -eq 3 ]
check "retries the export while the paused database wakes up" $?

setup "$(weeks 9)" 3
run_script
code=$?
[ "$code" -ne 0 ] && [ "$(exports | wc -l)" -eq 9 ] && grep -q "::error::" "$work/output" && ! grep -q "blob upload" "$work/calls"
check "gives up after the last attempt, uploading and deleting nothing" $?

setup "$(weeks 9)" 0 bad
run_script
code=$?
[ "$code" -ne 0 ] && [ "$(exports | wc -l)" -eq 9 ] && grep -q "::error::" "$work/output"
check "refuses an export that isn't a bacpac" $?

setup "$(weeks 9)" 0
touch "$work/fail_upload"
run_script
code=$?
[ "$code" -ne 0 ] && [ "$(exports | wc -l)" -eq 9 ] && ! grep -q "blob delete" "$work/calls"
check "deletes nothing when the upload fails" $?

setup "" 0
run_script SQL_CONNECTION_STRING="Server=localhost;Database=x;User Id=reader;Password=p"
grep -q "/SourceConnectionString:Server=localhost" "$work/calls" && ! grep -q "get-access-token" "$work/calls" && ! grep -q "/AccessToken" "$work/calls"
check "takes a connection string instead of a token for the local test database" $?

setup "" 0
PATH="$work/bin:$PATH" SQL_DATABASE=sqldb-kitchen-app BACKUP_STORAGE_ACCOUNT=x bash "$script" > "$work/output" 2>&1
[ $? -ne 0 ] && [ ! -s "$work/calls" ]
check "refuses to run without SQL_SERVER" $?

setup "" 0
run_script BACKUP_KEEP=0
code=$?
[ "$code" -ne 0 ] && ! grep -q "blob delete" "$work/calls"
check "refuses to keep fewer than one export" $?

if [ "$failures" -gt 0 ]; then echo "$failures failed"; exit 1; fi
echo "All passed"
