#!/usr/bin/env bash
set -euo pipefail

# node-pty does not publish a linux-x64 prebuild, so node-gyp compiles it during
# install. actions/setup-node already provides the matching headers; point
# node-gyp at those instead of downloading them again from nodejs.org.
node_root="$(dirname "$(dirname "$(command -v node)")")"
if [[ ! -f "$node_root/include/node/node.h" ]]; then
  echo "Node headers are missing from setup-node installation: $node_root" >&2
  exit 1
fi

# backmesh's runner image lacks what these jobs need from GitHub's Ubuntu
# image: Yarn, which setup-node's Corepack provides, and the OpenSSH client and
# Python pip and venv that the API and its tests use.
command -v yarn >/dev/null || corepack enable
if ! command -v ssh-keygen >/dev/null || ! python3 -m pip --version >/dev/null 2>&1 ||
  ! python3 -c 'import ensurepip' 2>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends openssh-client python3-pip python3-venv
fi

export npm_config_nodedir="$node_root"
yarn install --frozen-lockfile
