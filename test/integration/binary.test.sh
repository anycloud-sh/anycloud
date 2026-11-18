#!/bin/bash
set -e

echo "========================================="
echo "Binary Integration Test"
echo "========================================="
echo ""

# Clean existing binaries
echo "1. Cleaning existing binaries..."
rm -rf ./binaries
echo "   ✓ Cleaned"

echo ""
echo "2. Building all binaries..."
./release/build-binaries.sh
echo "   ✓ Build complete"

echo ""
echo "3. Verifying all 4 binaries exist..."
PLATFORMS=("linux-x64" "linux-arm64" "darwin-x64" "darwin-arm64")
for platform in "${PLATFORMS[@]}"; do
  BINARY="./binaries/anycloud-${platform}"
  if [ -f "$BINARY" ]; then
    SIZE=$(ls -lh "$BINARY" | awk '{print $5}')
    echo "   ✓ ${platform} exists (${SIZE})"
  else
    echo "   ✗ ${platform} missing"
    exit 1
  fi
done

# Determine current platform for runtime tests
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case $ARCH in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
PLATFORM="${OS}-${ARCH}"
TARBALL="./binaries/anycloud-${PLATFORM}.tar.gz"

# Clean room: unpack the release tarball and run the binary from a directory with NO node_modules
# reachable up the tree, mirroring a real install (binary in /usr/local/bin, no
# repo node_modules to fall back on). A `bun build --compile` binary that failed
# to embed a module resolves it against the on-disk filesystem at runtime; run
# from the repo checkout the repo's node_modules masks that failure — which is
# exactly how the "Cannot find module 'prompts/lib/elements/...'" startup crash
# shipped green in 0.1.21. The tarball is the published asset, holding
# `anycloud`, LICENSE and NOTICE, and every command below runs from this directory.
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anycloud-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_DIR"' EXIT
[ "$(tar -tzf "$TARBALL" | xargs)" = "anycloud LICENSE NOTICE" ] || { echo "   ✗ $TARBALL must hold anycloud, LICENSE and NOTICE"; exit 1; }
tar -xzf "$TARBALL" -C "$SMOKE_DIR"
run_smoke() { (cd "$SMOKE_DIR" && ./anycloud "$@"); }

echo ""
echo "4. Testing current platform binary (${PLATFORM})..."

echo ""
echo "   4a. Testing --version (clean room: no node_modules reachable)..."
# Capture stdout+stderr and the exit code INDEPENDENTLY. A crash message is also
# non-empty, so non-emptiness is not a success signal — assert exit 0 AND the
# absence of a module-load/crash marker. The `|| STATUS=$?` form keeps the real
# exit code without `set -e` aborting (a bare `VAR=$(failing-cmd)` assignment
# silently swallows the failure, which is part of how this regression hid).
VERSION_OUTPUT="$(run_smoke --version 2>&1)" && VERSION_STATUS=0 || VERSION_STATUS=$?
if [ "$VERSION_STATUS" -ne 0 ]; then
  echo "       ✗ --version exited ${VERSION_STATUS}"
  echo "$VERSION_OUTPUT" | head -20 | sed 's/^/         /'
  exit 1
fi
if echo "$VERSION_OUTPUT" | grep -Eqi "Cannot find module|^error:|panic|uncaught exception"; then
  echo "       ✗ --version printed an error marker (binary failed to embed a module?)"
  echo "$VERSION_OUTPUT" | head -20 | sed 's/^/         /'
  exit 1
fi
echo "       ✓ Version: $VERSION_OUTPUT"

echo ""
echo "   4b. Testing --help..."
HELP_OUTPUT=$(run_smoke --help 2>&1)
if echo "$HELP_OUTPUT" | grep -q "anycloud"; then
  echo "       ✓ Help output contains 'anycloud'"
else
  echo "       ✗ Help output missing 'anycloud'"
  exit 1
fi
if echo "$HELP_OUTPUT" | grep -q "Version: $VERSION_OUTPUT"; then
  echo "       ✓ Help output contains version"
else
  echo "       ✗ Help output missing version"
  exit 1
fi

echo ""
echo "   4c. Verifying all commands registered..."
COMMANDS=("login" "images" "job" "service" "status" "terminate" "update" "credentials" "exec")
for cmd in "${COMMANDS[@]}"; do
  if echo "$HELP_OUTPUT" | grep -q "$cmd"; then
    echo "       ✓ Command '$cmd' registered"
  else
    echo "       ✗ Command '$cmd' missing"
    exit 1
  fi
done
# One-release compatibility for 0.1.64 scripts; remove in 0.1.66.
for deprecated_cmd in submit run; do
  DEPRECATED_OUTPUT=$(run_smoke "$deprecated_cmd" --help 2>&1)
  if echo "$DEPRECATED_OUTPUT" | grep -q "Usage: anycloud job" &&
    echo "$DEPRECATED_OUTPUT" | grep -q "\`anycloud $deprecated_cmd\` is deprecated; use \`anycloud job\`"; then
    echo "       ✓ Deprecated command '$deprecated_cmd' runs 'job' with a warning"
  else
    echo "       ✗ Deprecated command '$deprecated_cmd' does not run 'job' with a warning"
    exit 1
  fi
done
for removed_cmd in build config serve; do
  if run_smoke "$removed_cmd" 2>&1 | grep -q "unknown command '$removed_cmd'"; then
    echo "       ✓ Removed command '$removed_cmd' is not registered"
  else
    echo "       ✗ Removed command '$removed_cmd' is still registered"
    exit 1
  fi
done

echo ""
echo "   4d. Testing 'update --help'..."
UPDATE_HELP=$(run_smoke update --help 2>&1)
if echo "$UPDATE_HELP" | grep -q "Update anycloud CLI"; then
  echo "       ✓ Update command works"
else
  echo "       ✗ Update command failed"
  exit 1
fi

echo ""
echo "   4e. Testing 'api upgrade --help'..."
API_UPGRADE_HELP=$(run_smoke api upgrade --help 2>&1)
if echo "$API_UPGRADE_HELP" | grep -q "Upgrade the active API"; then
  echo "       ✓ API upgrade command works"
else
  echo "       ✗ API upgrade command failed"
  exit 1
fi

echo ""
echo "   4f. Testing 'credentials --help'..."
CREDS_HELP=$(run_smoke credentials --help 2>&1)
if echo "$CREDS_HELP" | grep -q "credentials"; then
  echo "       ✓ Credentials command works"
else
  echo "       ✗ Credentials command failed"
  exit 1
fi

echo ""
echo "   4g. Testing removed 'config' command..."
if CONFIG_HELP=$(run_smoke config 2>&1); then
  echo "       ✗ Removed config command unexpectedly succeeded"
  exit 1
fi
if echo "$CONFIG_HELP" | grep -qi "unknown command"; then
  echo "       ✓ Removed config command fails immediately"
else
  echo "       ✗ Removed config command did not report an unknown command"
  echo "$CONFIG_HELP" | head -10 | sed 's/^/       /'
  exit 1
fi

echo ""
echo "   4h. Testing a prompts-loading command in clean room (guards lazy element requires)..."
# `credentials new` pulls in the interactive prompts path. In non-TTY CI it
# exits early ("prompts not available in non-interactive mode"), but the prompts
# element modules are still LOADED at import time — which is where an un-embedded
# module blows up. We accept the early-exit nonzero status and only fail on a
# module-load/runtime crash (so `^error:`, which the early-exit message matches,
# is intentionally excluded here).
CREDS_OUTPUT="$(run_smoke credentials new 2>&1)" && CREDS_STATUS=0 || CREDS_STATUS=$?
if echo "$CREDS_OUTPUT" | grep -Eqi "Cannot find module|panic|uncaught exception"; then
  echo "       ✗ prompts-loading command hit a module-load/runtime crash"
  echo "$CREDS_OUTPUT" | head -20 | sed 's/^/         /'
  exit 1
fi
echo "       ✓ prompts-loading command loaded without a module crash (exit ${CREDS_STATUS})"

echo ""
echo "5. Verifying binary sizes (should be 50-150MB)..."
for platform in "${PLATFORMS[@]}"; do
  BINARY_PATH="./binaries/anycloud-${platform}"
  # Cross-platform size check
  if [[ "$OSTYPE" == "darwin"* ]]; then
    SIZE=$(stat -f%z "$BINARY_PATH")
  else
    SIZE=$(stat -c%s "$BINARY_PATH")
  fi
  SIZE_MB=$((SIZE / 1024 / 1024))
  if [ "$SIZE_MB" -gt 50 ] && [ "$SIZE_MB" -lt 150 ]; then
    echo "   ✓ ${platform}: ${SIZE_MB}MB"
  else
    echo "   ✗ ${platform}: ${SIZE_MB}MB (unexpected size)"
    exit 1
  fi
done

echo ""
echo "========================================="
echo "All binary tests PASSED!"
echo "========================================="
