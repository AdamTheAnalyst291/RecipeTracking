#!/usr/bin/env bash
# Tests for alert.sh with fake `az` and `curl`: nothing leaves the machine.
#   bash warehouse/scripts/tests/alert.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../alert.sh"
failures=0

# setup <topic the fake vault holds> [curl exit code]
setup() {
  work="$(mktemp -d)"
  mkdir -p "$work/bin"
  : > "$work/calls"
  cat > "$work/bin/az" <<EOF
#!/usr/bin/env bash
echo "az \$*" >> "$work/calls"
printf '%s\n' "$1"
EOF
  cat > "$work/bin/curl" <<EOF
#!/usr/bin/env bash
printf 'curl' >> "$work/calls"
printf ' [%s]' "\$@" >> "$work/calls"
echo >> "$work/calls"
exit ${2:-0}
EOF
  chmod +x "$work/bin/az" "$work/bin/curl"
}

run() { # run [env assignments...]: runs alert.sh, keeping its output and exit code
  out="$(env PATH="$work/bin:$PATH" KEY_VAULT_NAME=kv-kitchen-dev-abc123 GITHUB_ACTIONS= "$@" bash "$script" "Warehouse build failed" "dbt build failed on Dev" 2>&1)"
  code=$?
}

check() { # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; echo "$out" | sed 's/^/     /'; sed 's/^/     calls: /' "$work/calls"; failures=$((failures + 1)); fi
}

setup "kitchen-0123456789abcdef"
run
check "reads the topic from the vault's ntfy-topic secret" grep -q "az keyvault secret show --vault-name kv-kitchen-dev-abc123 --name ntfy-topic" "$work/calls"
check "posts the alert to the topic" grep -q "\[https://ntfy.sh/kitchen-0123456789abcdef\]" "$work/calls"
check "sends the title and message" grep -q "\[Title: Warehouse build failed\].*\[dbt build failed on Dev\]\|\[dbt build failed on Dev\].*\[Title: Warehouse build failed\]" "$work/calls"
check "exits 0" test "$code" -eq 0
rm -rf "$work"

setup "kitchen-0123456789abcdef"
run DRY_RUN=true
check "a dry run reads no secret and sends nothing" test ! -s "$work/calls"
check "a dry run says what it would send" grep -q "Would send.*Warehouse build failed" <<< "$out"
check "a dry run exits 0" test "$code" -eq 0
rm -rf "$work"

setup "kitchen-0123456789abcdef"
run GITHUB_ACTIONS=true
check "masks the topic in GitHub Actions logs" grep -q "::add-mask::kitchen-0123456789abcdef" <<< "$out"
rm -rf "$work"

setup "not a topic/../x"
run
check "refuses a topic that isn't letters, digits, - and _" test "$code" -ne 0
check "never posts to a bad topic" bash -c "! grep -q curl '$work/calls'"
rm -rf "$work"

setup ""
run
check "fails when the secret is empty" test "$code" -ne 0
rm -rf "$work"

setup "kitchen-0123456789abcdef" 22
run
check "fails when ntfy refuses the alert" test "$code" -ne 0
rm -rf "$work"

setup "kitchen-0123456789abcdef"
out="$(env PATH="$work/bin:$PATH" KEY_VAULT_NAME= bash "$script" "t" "m" 2>&1)"; code=$?
check "fails without KEY_VAULT_NAME" test "$code" -ne 0
rm -rf "$work"

if [ "$failures" -gt 0 ]; then echo "$failures failed"; exit 1; fi
echo "All passed"
