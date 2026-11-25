#!/usr/bin/env bash
# Tests for deploy-api.sh with fake `az` and `curl`: nothing leaves the machine.
#   bash infra/scripts/tests/deploy-api.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../deploy-api.sh"
failures=0

# setup <failed POSTs before one succeeds> <deployment status to report>
setup() {
  work="$(mktemp -d)"
  mkdir -p "$work/bin"
  echo "fake zip" > "$work/api.zip"
  echo "$1" > "$work/fail_posts"
  echo "$2" > "$work/status"
  : > "$work/calls"

  cat > "$work/bin/az" <<'EOF'
#!/usr/bin/env bash
echo "fake-token"
EOF

  # Records each call. POST: fails with HTTP 400 while fail_posts > 0, then answers
  # 202 with a Location header. GET: returns the deployment status.
  cat > "$work/bin/curl" <<EOF
#!/usr/bin/env bash
work="$work"
EOF
  cat >> "$work/bin/curl" <<'EOF'
method=GET headers_file="" out=/dev/stdout
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -X) method="${args[i + 1]}" ;;
    -D) headers_file="${args[i + 1]}" ;;
    -o) out="${args[i + 1]}" ;;
  esac
done
echo "$method" >> "$work/calls"
if [ "$method" = POST ]; then
  left=$(cat "$work/fail_posts")
  if [ "$left" -gt 0 ]; then
    echo $((left - 1)) > "$work/fail_posts"
    printf 'HTTP/1.1 400 Bad Request\r\n\r\n' > "$headers_file"
    echo '{"error":"not ready"}' > "$out"
    printf '400'
  else
    printf 'HTTP/1.1 202 Accepted\r\nLocation: https://example.test/api/deployments/1\r\n\r\n' > "$headers_file"
    : > "$out"
    printf '202'
  fi
else
  printf '{"id":"1","status": %s,"status_text":"x"}' "$(cat "$work/status")"
fi
EOF
  chmod +x "$work/bin/az" "$work/bin/curl"
}

run_script() {
  PATH="$work/bin:$PATH" FUNCTION_APP=func-test API_ZIP="$work/api.zip" \
    PUBLISH_ATTEMPTS=3 PUBLISH_RETRY_DELAY=0 STATUS_DELAY=0 STATUS_ATTEMPTS=3 \
    bash "$script" > "$work/output" 2>&1
}

check() { # check <name> <condition result>
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$work/output"; failures=$((failures + 1)); fi
}

setup 0 4
run_script
check "deploys on the first try" $?

setup 2 4
run_script
code=$?
posts=$(grep -c POST "$work/calls")
[ "$code" -eq 0 ] && [ "$posts" -eq 3 ]
check "retries the upload when the new app's publish endpoint answers 400" $?

setup 3 4
run_script
code=$?
posts=$(grep -c POST "$work/calls")
[ "$code" -ne 0 ] && [ "$posts" -eq 3 ] && grep -q "::error::" "$work/output"
check "gives up with an error after the last attempt" $?

setup 0 3
run_script
code=$?
[ "$code" -ne 0 ] && grep -q "deployment failed" "$work/output"
check "fails when the deployment fails" $?

setup 0 1
run_script
code=$?
[ "$code" -ne 0 ] && grep -q "did not finish" "$work/output"
check "fails when the deployment never finishes" $?

setup 0 4
PATH="$work/bin:$PATH" API_ZIP="$work/api.zip" bash "$script" > "$work/output" 2>&1
code=$?
[ "$code" -ne 0 ]
check "refuses to run without FUNCTION_APP" $?

if [ "$failures" -gt 0 ]; then echo "$failures failed"; exit 1; fi
echo "All passed"
