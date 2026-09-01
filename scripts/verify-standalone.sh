#!/usr/bin/env bash
# Proves a release binary carries the room UI inside it.
#
# build.rs embeds an empty placeholder when self-host-dist/ is missing at compile
# time, and the relay then quietly falls back to reading the UI from disk. That
# fallback is right for development and wrong for a download: it would ship an
# executable that serves a blank page on any machine but the build runner. This
# runs the binary alone in an empty directory, where the disk fallback cannot
# possibly succeed, and fails if the UI does not come back over HTTP.
set -euo pipefail

binary="${1:?usage: verify-standalone.sh <path-to-binary>}"
[[ -x "$binary" ]] || { echo "not an executable: $binary" >&2; exit 1; }

port="${VERIFY_PORT:-38217}"
workdir="$(mktemp -d)"
cp "$binary" "$workdir/"
name="$(basename "$binary")"

cleanup() {
  # Capture the real result first: this runs on every exit, and without the
  # explicit exit below a failure while tidying up would replace the verdict.
  # That is not hypothetical — on Windows the killed relay keeps its directory
  # busy for a moment, so rm failed and turned a passing run into a red job.
  local status=$?
  if [[ -n "${relay_pid:-}" ]]; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 10); do
    rm -rf "$workdir" 2>/dev/null && break
    sleep 0.5
  done
  exit "$status"
}
trap cleanup EXIT

# Start the relay directly rather than inside a subshell, so $! is the relay's own
# PID. Killing a subshell leaves the relay orphaned and still holding the port,
# and the next run then probes that stale process and passes against the wrong
# binary. Fail loudly if the port is already taken for any reason.
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
  echo "port ${port} is already serving; refusing to test against another process" >&2
  exit 1
fi

echo "Running $name alone in $workdir"
pushd "$workdir" >/dev/null
PORT="$port" CINDER_ROUTES=local CINDER_OPEN_BROWSER=false "./$name" >relay.log 2>&1 &
relay_pid=$!
popd >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS -o /dev/null "http://127.0.0.1:${port}/api/health"; then
  echo "relay never became healthy on port ${port}" >&2
  cat "$workdir/relay.log" >&2 || true
  exit 1
fi

failed=0
# app.js is the whole client bundle and app.css the whole stylesheet; anything
# smaller than these floors means a placeholder got embedded instead of the file.
check() {
  local path="$1" minimum="$2" status size
  status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/${path}")"
  size="$(curl -s -o /dev/null -w '%{size_download}' "http://127.0.0.1:${port}/${path}")"
  if [[ "$status" != "200" || "$size" -lt "$minimum" ]]; then
    echo "FAIL /${path}: status=${status} bytes=${size} (want 200 and >= ${minimum})" >&2
    failed=1
  else
    echo "ok /${path}: ${size} bytes"
  fi
}

check "app.js" 200000
check "app.css" 10000
check "e2ee-worker.js" 10000
check "favicon.svg" 100
check "manifest.webmanifest" 50

if [[ "$failed" -ne 0 ]]; then
  echo "The binary is not self-contained: build the room UI before cargo build." >&2
  cat "$workdir/relay.log" >&2 || true
  exit 1
fi

echo "The binary serves the full room UI with no files beside it."
