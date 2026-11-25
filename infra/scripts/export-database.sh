#!/usr/bin/env bash
# Exports an Azure SQL database to a .bacpac with SqlPackage, uploads it to blob storage,
# and keeps the newest BACKUP_KEEP exports of that database (card S2). Used by the weekly
# Backup Prod workflow, signed in to the Azure CLI as the backup identity
# (kitchen-github-prod-backup): read-only in the database, Storage Blob Data Contributor
# on the export container, nothing else. No password or key is involved.
#
#   SQL_SERVER=<server>.database.windows.net SQL_DATABASE=sqldb-kitchen-app \
#     BACKUP_STORAGE_ACCOUNT=<account> infra/scripts/export-database.sh
#
# Exports land at <container>/<database>/<database>-<UTC yyyymmddThhmmssZ>.bacpac, so name
# order is time order. Older ones are deleted only after the new one is safely uploaded;
# the account's versioning and soft delete keep deleted ones for 30 days more.
#
# SQL_CONNECTION_STRING replaces the Entra token, for the CI test against a local SQL
# Server (tests/export-database.integration.sh). The workflow never sets it.
set -euo pipefail

: "${SQL_SERVER:?Set SQL_SERVER to the full server name}"
: "${SQL_DATABASE:?Set SQL_DATABASE}"
: "${BACKUP_STORAGE_ACCOUNT:?Set BACKUP_STORAGE_ACCOUNT to the export storage account}"
container="${BACKUP_CONTAINER:-database-exports}"
keep="${BACKUP_KEEP:-8}"
export_attempts="${EXPORT_ATTEMPTS:-4}"
export_retry_delay="${EXPORT_RETRY_DELAY:-60}"
read -ra sqlpackage <<< "${SQLPACKAGE:-sqlpackage}"

if ! [[ "$keep" =~ ^[0-9]+$ ]] || [ "$keep" -lt 1 ]; then
  echo "::error::BACKUP_KEEP must be a whole number of at least 1, not '$keep'"; exit 1
fi

work="${WORK_DIR:-$(mktemp -d)}"
mkdir -p "$work"
trap 'rm -f "$work"/*.bacpac' EXIT

stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$work/$SQL_DATABASE-$stamp.bacpac"
blob="$SQL_DATABASE/$SQL_DATABASE-$stamp.bacpac"

if [ -n "${SQL_CONNECTION_STRING:-}" ]; then
  source_args=("/SourceConnectionString:$SQL_CONNECTION_STRING")
else
  token=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv)
  echo "::add-mask::$token"
  source_args=("/SourceServerName:$SQL_SERVER" "/SourceDatabaseName:$SQL_DATABASE" "/AccessToken:$token" "/SourceEncryptConnection:True")
fi

# The free-tier database pauses when idle and refuses connections (error 40613) for about
# a minute while it wakes, so the export is retried.
exported=""
for attempt in $(seq 1 "$export_attempts"); do
  rm -f "$file"
  if "${sqlpackage[@]}" /Action:Export "${source_args[@]}" "/TargetFile:$file" /Quiet:True; then
    exported=yes
    break
  fi
  echo "Export failed (attempt $attempt of $export_attempts)"
  if [ "$attempt" -lt "$export_attempts" ]; then sleep "$export_retry_delay"; fi
done
[ -n "$exported" ] || { echo "::error::SqlPackage could not export $SQL_DATABASE after $export_attempts attempts"; exit 1; }

# A bacpac is a zip file. Anything else means the export went wrong.
if [ ! -s "$file" ] || [ "$(head -c 2 "$file")" != "PK" ]; then
  echo "::error::The export of $SQL_DATABASE is not a bacpac"; exit 1
fi
size=$(wc -c < "$file" | tr -d ' ')
echo "Exported $SQL_DATABASE ($size bytes)"

storage=(--auth-mode login --account-name "$BACKUP_STORAGE_ACCOUNT" --container-name "$container" --only-show-errors)

az storage blob upload "${storage[@]}" --name "$blob" --file "$file" --overwrite false > /dev/null
echo "Uploaded $container/$blob"

# Newest first; the timestamp in the name sorts in time order.
mapfile -t existing < <(az storage blob list "${storage[@]}" --prefix "$SQL_DATABASE/$SQL_DATABASE-" --query "[].name" -o tsv \
  | tr -d '\r' | grep -E "^$SQL_DATABASE/$SQL_DATABASE-[0-9]{8}T[0-9]{6}Z\.bacpac\$" | sort -r || true)

if ! printf '%s\n' "${existing[@]}" | grep -qxF "$blob"; then
  echo "::error::The new export isn't in the container's listing, so nothing old is deleted"; exit 1
fi

deleted=0
for old in "${existing[@]:$keep}"; do
  az storage blob delete "${storage[@]}" --name "$old" > /dev/null
  echo "Deleted $old (versioning and soft delete keep it for 30 days)"
  deleted=$((deleted + 1))
done
kept=$(( ${#existing[@]} - deleted ))

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### $SQL_DATABASE exported"
    echo "- New export: \`$container/$blob\` ($size bytes)"
    echo "- Exports kept: $kept (newest $keep), deleted: $deleted"
  } >> "$GITHUB_STEP_SUMMARY"
fi
