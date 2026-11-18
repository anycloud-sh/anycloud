#!/usr/bin/env bash
#
# Resolve the prebuilt deps base image for a dependency tree, or fall back to the
# local inline Dockerfile stage when no matching base exists in GHCR.
#
# Usage:
#   scripts/resolve-deps-image.sh <full|prod>   -> prints a Docker build-arg value:
#       ghcr.io/anycloud-sh/api-deps-<tree>:<key>   (when that image exists), or
#       deps-<tree>-inline                          (fallback: local Dockerfile stage)
#   scripts/resolve-deps-image.sh hash            -> prints just the deps cache key
#       (build-deps-base.yml calls this so the tag it pushes and the tag callers
#        look up are computed by the SAME code and can never drift)
#
# The cache key hashes EVERYTHING that determines the baked node_modules, not just
# yarn.lock: (1) yarn.lock = resolved versions; (2) package.json's dependency
# classification, because the prod base is `yarn install --production` so its
# contents depend on which packages are in `dependencies` — and moving a package
# between dependencies/devDependencies leaves yarn.lock byte-identical (yarn v1's
# lockfile doesn't record the prod/dev split); (3) the Dockerfile, since the
# install stages / base tooling shape the tree too. The package.json *version* is
# excluded so the per-release version bump still reuses the base.
#
# Callers of <full|prod> MUST `docker login ghcr.io` first: the api-deps-* packages
# are private, so an unauthenticated `docker manifest inspect` fails closed and
# would silently force the inline fallback forever. The stderr log distinguishes an
# auth/config failure from a genuine "base not built yet".
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }

manifest_inspect() {
  local ref="$1"
  local timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  fi

  if [ -n "$timeout_bin" ]; then
    "$timeout_bin" -k 5 60 docker manifest inspect "$ref"
  else
    docker manifest inspect "$ref"
  fi
}

# Hash of all inputs that affect node_modules content (version field excluded).
# yarn.lock is marked `binary` in .gitattributes, so no CRLF normalization skews
# the hash per-OS; node -p over the same package.json is deterministic.
deps_key() {
  {
    cat "$root/yarn.lock"
    node -p "const p=require('$root/package.json'); JSON.stringify({dependencies:p.dependencies||{}, devDependencies:p.devDependencies||{}, optionalDependencies:p.optionalDependencies||{}})"
    cat "$root/Dockerfile"
  } | sha256 | cut -d' ' -f1
}

cmd="${1:-}"
case "$cmd" in
  hash)
    deps_key
    exit 0
    ;;
  full | prod) ;;
  *)
    echo "usage: $0 <full|prod|hash>" >&2
    exit 2
    ;;
esac

tree="$cmd"
key="$(deps_key)"
image="$(node -p "require('$root/package.json').apiImage")-deps-${tree}"
ref="${image}:${key}"

if err="$(manifest_inspect "$ref" 2>&1 >/dev/null)"; then
  echo "resolve-deps-image: using prebuilt base ${ref}" >&2
  echo "$ref"
else
  echo "resolve-deps-image: ${ref} unavailable -> falling back to inline build (deps-${tree}-inline)" >&2
  echo "resolve-deps-image: (docker manifest inspect said: ${err})" >&2
  echo "deps-${tree}-inline"
fi
