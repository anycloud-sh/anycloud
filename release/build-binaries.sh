#!/bin/bash
set -e

if [ -n "${ANYCLOUD_BINARY_TARGETS:-}" ]; then
  read -r -a TARGETS <<< "$ANYCLOUD_BINARY_TARGETS"
else
  TARGETS=("bun-linux-x64" "bun-linux-arm64" "bun-darwin-x64" "bun-darwin-arm64")
fi

# Bun's darwin output carries a code signature Apple Silicon rejects at launch
# (Bun 1.3.3 hashes the last page zero-padded; darwin-x64 keeps the template's
# stale signature), so each darwin binary is ad-hoc re-signed and verified.
# On Linux that uses rcodesign, pinned by version and checksum.
RCODESIGN_VERSION=0.29.0
rcodesign_dir=""
trap '[ -z "$rcodesign_dir" ] || rm -rf "$rcodesign_dir"' EXIT
ad_hoc_sign() {
  if [ "$(uname -s)" = Darwin ]; then
    codesign --force --sign - "$1"
    return
  fi
  local arch sha name
  arch="$(uname -m)"
  name="apple-codesign-${RCODESIGN_VERSION}-${arch}-unknown-linux-musl"
  if [ -z "$rcodesign_dir" ]; then
    case "$arch" in
      x86_64) sha=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 ;;
      aarch64) sha=4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f ;;
      *) echo "No pinned rcodesign for $arch" >&2; exit 1 ;;
    esac
    rcodesign_dir="$(mktemp -d)"
    curl -fsSL -o "$rcodesign_dir/rcodesign.tar.gz" \
      "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${RCODESIGN_VERSION}/${name}.tar.gz"
    echo "$sha  $rcodesign_dir/rcodesign.tar.gz" | sha256sum -c --quiet
    tar -xzf "$rcodesign_dir/rcodesign.tar.gz" -C "$rcodesign_dir"
  fi
  "$rcodesign_dir/$name/rcodesign" sign "$1"
}

echo "Building TypeScript..."
yarn build

mkdir -p binaries

# Each tarball carries LICENSE and a NOTICE for the Bun runtime and the
# packages the binary embeds, which release/notice.mjs reads from a plain
# bundle. A Bun bump fails here until its licence is vendored.
stage=binaries/stage
mkdir -p "$stage"
bun_version="$(node -p "require('./node_modules/bun/package.json').version")"
npx bun build ./dist/cli/index.js --target=bun --outfile "$stage/cli.js" >/dev/null
{
  cat <<'NOTICE'
anycloud
Copyright 2025 anycloud

anycloud is licensed under the Apache License, Version 2.0 (LICENSE, next to
this file). The binary embeds the Bun runtime and the packages below, under
their own licences.
NOTICE
  printf '\n%s\n\nBun %s, from https://github.com/oven-sh/bun/blob/bun-v%s/LICENSE.md\n\n' \
    "$(printf -- '-%.0s' {1..78})" "$bun_version" "$bun_version"
  cat "release/licenses/bun-$bun_version-LICENSE.md"
  node release/notice.mjs "$stage/cli.js"
} >"$stage/NOTICE"
rm "$stage/cli.js"
cp LICENSE "$stage/"

for target in "${TARGETS[@]}"; do
  platform="${target#bun-}"  # Remove "bun-" prefix
  echo "Building for $platform..."
  npx bun build --compile --target=$target ./dist/cli/index.js --outfile "binaries/anycloud-$platform"
  if [[ "$platform" == darwin-* ]]; then
    npx tsx scripts/macho-signature.ts fit "binaries/anycloud-$platform"
    ad_hoc_sign "binaries/anycloud-$platform"
    npx tsx scripts/macho-signature.ts verify "binaries/anycloud-$platform"
  fi
  cp "binaries/anycloud-$platform" "$stage/anycloud"
  tar -czf "binaries/anycloud-$platform.tar.gz" -C "$stage" anycloud LICENSE NOTICE
done
rm -r "$stage"

echo ""
echo "Binaries built:"
ls -la binaries/
