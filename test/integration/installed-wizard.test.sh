#!/bin/bash
set -euo pipefail

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/anycloud-installed-wizard.XXXXXX")"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture for installed wizard test: $ARCH" >&2
    exit 1
    ;;
esac
PLATFORM="${OS}-${ARCH}"
TARGET="bun-${PLATFORM}"
BINARY="binaries/anycloud-${PLATFORM}"
ASSET_NAME="anycloud-${PLATFORM}.tar.gz"
ASSET_PATH="${TEST_ROOT}/${ASSET_NAME}"
CHECKSUMS_PATH="${TEST_ROOT}/checksums.txt"
PACKAGE_ROOT="${TEST_ROOT}/package"
INSTALL_ROOT="${TEST_ROOT}/installed/bin"
FAKE_BIN="${TEST_ROOT}/fake-bin"
VERSION="$(node -p "require('./package.json').version")"

echo "Building current ${PLATFORM} release-candidate binary..."
ANYCLOUD_BINARY_TARGETS="$TARGET" bash release/build-binaries.sh

mkdir -p "$PACKAGE_ROOT" "$INSTALL_ROOT" "$FAKE_BIN"
cp "$BINARY" "$PACKAGE_ROOT/anycloud"
chmod +x "$PACKAGE_ROOT/anycloud"
tar -czf "$ASSET_PATH" -C "$PACKAGE_ROOT" anycloud

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM="$(sha256sum "$ASSET_PATH" | awk '{print $1}')"
else
  CHECKSUM="$(shasum -a 256 "$ASSET_PATH" | awk '{print $1}')"
fi
printf '%s  %s\n' "$CHECKSUM" "$ASSET_NAME" > "$CHECKSUMS_PATH"

cat > "${FAKE_BIN}/curl" <<'CURL'
#!/bin/bash
set -euo pipefail
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output)
      output="$2"
      shift 2
      ;;
    -*o)
      output="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
case "$url" in
  */checksums.txt) source_path="$CHECKSUMS_PATH" ;;
  */"$ASSET_NAME") source_path="$ASSET_PATH" ;;
  *)
    echo "Unexpected installer URL: $url" >&2
    exit 1
    ;;
esac
cp "$source_path" "$output"
CURL
chmod +x "${FAKE_BIN}/curl"

echo "Installing the release candidate through release/install.sh..."
PATH="${FAKE_BIN}:$PATH" \
  ASSET_NAME="$ASSET_NAME" \
  ASSET_PATH="$ASSET_PATH" \
  CHECKSUMS_PATH="$CHECKSUMS_PATH" \
  sh release/install.sh --version "$VERSION" --install-dir "$INSTALL_ROOT"

INSTALLED_BINARY="${INSTALL_ROOT}/anycloud"
test -x "$INSTALLED_BINARY"
VERSION_OUTPUT="$($INSTALLED_BINARY --version)"
if [ "$VERSION_OUTPUT" != "$VERSION" ]; then
  echo "Installed binary reported unexpected version: $VERSION_OUTPUT" >&2
  exit 1
fi

echo "Running every fake-provider bare wizard contract with the installed binary..."
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
ANYCLOUD_TEST_CLI_BINARY="$INSTALLED_BINARY" \
  ANYCLOUD_TEST_INSTALLED_BINARY="$INSTALLED_BINARY" \
  yarn vitest run \
    test/integration/credentials-onboarding/common/terminal.spec.ts \
    test/integration/credentials-onboarding/aws/terminal.spec.ts \
    test/integration/credentials-onboarding/azure/terminal.spec.ts \
    test/integration/credentials-onboarding/gcp/terminal.spec.ts \
    test/integration/credentials-onboarding/installed/terminal.spec.ts \
    --maxWorkers=1

echo "Installed release-candidate wizard contract passed."
