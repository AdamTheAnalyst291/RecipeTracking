#!/usr/bin/env bash
# Shared by the export tests: writes a fake `az` whose blob container is a local folder.
#   source fake-az-storage.sh; make_fake_az <bin dir> <container dir> <calls log> [fail-upload flag file]
# It logs each call, hands out a fake SQL token, and uploads, lists (by --prefix) and
# deletes files in the folder. Upload fails while the flag file exists.

make_fake_az() {
  cat > "$1/az" <<EOF
#!/usr/bin/env bash
container="$2"
calls="$3"
fail_upload="${4:-/nonexistent}"
EOF
  cat >> "$1/az" <<'EOF'
echo "az $*" >> "$calls"
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
case "$1 $2 ${3:-}" in
  "account get-access-token"*) echo "fake-sql-token" ;;
  "storage blob upload")
    [ -f "$fail_upload" ] && { echo "upload refused" >&2; exit 1; }
    name=$(arg --name "$@"); mkdir -p "$container/$(dirname "$name")"
    cp "$(arg --file "$@")" "$container/$name" ;;
  "storage blob list")
    (cd "$container" && find . -type f | sed 's|^\./||' | grep "^$(arg --prefix "$@")" || true) ;;
  "storage blob delete") rm "$container/$(arg --name "$@")" ;;
  *) echo "unexpected az call: $*" >&2; exit 1 ;;
esac
EOF
  chmod +x "$1/az"
}
