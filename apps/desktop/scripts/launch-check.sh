#!/usr/bin/env bash
# launch-check.sh <app executable> [seconds]: start the PACKAGED app (signed out, a throwaway profile)
# and wait until its bundled engine is running. Fails when the app reports that it cannot start the
# engine (for example "The bundled engine was changed"), or when no engine runs within the time.
# macOS: the executable inside the .app (Contents/MacOS/<name>); Linux: run under a display (xvfb-run).
set -uo pipefail
exe=${1:?app executable}; limit=${2:-120}
work=$(mktemp -d); log="$work/app.log"
dir=$(cd "$(dirname "$exe")" && pwd)
# This app's own sidecars: <app>/Contents/Resources (macOS) or <dir>/resources (Linux, Windows).
if [ -d "$dir/../Resources/sidecars" ]; then sidecars=$(cd "$dir/../Resources/sidecars" && pwd); else sidecars="$dir/resources/sidecars"; fi
cleanup() {
  [ -n "${app_pid:-}" ] && kill "$app_pid" 2>/dev/null
  sleep 2
  pkill -f "$sidecars/opencode" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT
# Linux CI and test boxes have no setuid sandbox helper.
extra=(); [ "$(uname -s)" = Linux ] && extra=(--no-sandbox)
OMNIRUSH_ELECTRON_USERDATA="$work/profile" OMNIRUSH_DATA_DIR="$work/data" OMNIRUSH_AUTO_UPDATE=0 \
  OMNIRUSH_POSTHOG_HOST=http://127.0.0.1:9 "$exe" "${extra[@]}" > "$log" 2>&1 &
app_pid=$!
for _ in $(seq "$limit"); do
  if grep -qE "engineStart failed|only runs the engine it ships with|bundled engine was changed" "$log"; then
    echo "launch-check: the app cannot start its engine:" >&2
    grep -m3 -E "engineStart failed|only runs the engine it ships with|bundled engine was changed" "$log" >&2
    exit 1
  fi
  if pgrep -f "$sidecars/opencode" > /dev/null; then
    echo "launch-check: the app started and its bundled engine is running"
    exit 0
  fi
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "launch-check: the app exited before its engine started" >&2
    tail -20 "$log" >&2
    exit 1
  fi
  sleep 1
done
echo "launch-check: no engine running after ${limit}s" >&2
tail -20 "$log" >&2
exit 1
