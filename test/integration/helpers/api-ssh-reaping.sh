#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_IMAGE="${1:?Usage: api-ssh-reaping.sh <api-image>}"
SSH_REAPING_SERVER="api-ssh-reaping-server-$$"
SSH_REAPING_CLIENT="api-ssh-reaping-client-$$"
SSH_REAPING_NETWORK="api-ssh-reaping-$$"
SSH_REAPING_SERVER_IMAGE="anycloud-ssh-reaping-server-test-$$"
SSH_REAPING_BUILD_DIR=$(mktemp -d)
SSH_RUNTIME_TMPFS=/run/anycloud-ssh:rw,noexec,nosuid,nodev,size=1m,mode=0700

source "$SCRIPT_DIR/common.sh"

cleanup() {
    docker rm -f "$SSH_REAPING_CLIENT" "$SSH_REAPING_SERVER" >/dev/null 2>&1 || true
    docker network rm "$SSH_REAPING_NETWORK" >/dev/null 2>&1 || true
    docker image rm "$SSH_REAPING_SERVER_IMAGE" >/dev/null 2>&1 || true
    rm -rf "$SSH_REAPING_BUILD_DIR"
}

trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$SSH_REAPING_BUILD_DIR/id_ed25519"
cp "$SCRIPT_DIR/../fixtures/ssh-api-image-reaping.Dockerfile" "$SSH_REAPING_BUILD_DIR/Dockerfile"
cp "$SSH_REAPING_BUILD_DIR/id_ed25519.pub" "$SSH_REAPING_BUILD_DIR/authorized_keys"
retry_cmd 3 15 docker build \
    --build-arg "API_IMAGE=$API_IMAGE" \
    -t "$SSH_REAPING_SERVER_IMAGE" \
    "$SSH_REAPING_BUILD_DIR" >/dev/null
docker network create "$SSH_REAPING_NETWORK" >/dev/null
docker run -d \
    --name "$SSH_REAPING_SERVER" \
    --network "$SSH_REAPING_NETWORK" \
    --network-alias ssh-reaping-server \
    "$SSH_REAPING_SERVER_IMAGE" >/dev/null
docker run -d \
    --name "$SSH_REAPING_CLIENT" \
    --network "$SSH_REAPING_NETWORK" \
    --tmpfs "$SSH_RUNTIME_TMPFS" \
    -e CIPHER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    -v "$SSH_REAPING_BUILD_DIR/id_ed25519:/fixture/id_ed25519:ro" \
    -v "$SCRIPT_DIR/ssh-api-image-reaping.mjs:/fixture/reaping.mjs:ro" \
    "$API_IMAGE" node /fixture/reaping.mjs >/dev/null

SSH_REAPING_READY=false
for _ in $(seq 1 60); do
    if docker logs "$SSH_REAPING_CLIENT" 2>&1 | grep -q '"event":"ssh-reaping-ready"'; then
        SSH_REAPING_READY=true
        break
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$SSH_REAPING_CLIENT" 2>/dev/null || echo false)" != "true" ]; then
        break
    fi
    sleep 1
done
if [ "$SSH_REAPING_READY" != true ]; then
    print_error "API image SSH reaping probe did not become ready"
    docker logs "$SSH_REAPING_CLIENT" 2>&1 | tail -30
    exit 1
fi

SSH_REAPING_REPORT=$(docker exec "$SSH_REAPING_CLIENT" node --input-type=commonjs --eval '
const fs = require("node:fs");
const stateCounts = {};
let zombies = 0;
let ppid1Zombies = 0;
let helpers = 0;
let sshClients = 0;
for (const name of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  let status;
  try { status = fs.readFileSync(`/proc/${name}/status`, "utf8"); } catch { continue; }
  const state = status.match(/^State:\s+([A-Za-z?])/m)?.[1] ?? "?";
  const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? -1);
  if (/^Name:\s+ssh$/m.test(status)) sshClients += 1;
  try {
    const args = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
    if (args.some((arg) => arg.endsWith("/ssh-process-helper.js"))) helpers += 1;
  } catch { /* A short-lived process can exit during the snapshot. */ }
  stateCounts[state] = (stateCounts[state] ?? 0) + 1;
  if (state === "Z") {
    zombies += 1;
    if (ppid === 1) ppid1Zombies += 1;
  }
}
process.stdout.write(JSON.stringify({ stateCounts, zombies, ppid1Zombies, helpers, sshClients }));
')
if ! echo "$SSH_REAPING_REPORT" | jq -e '.zombies == 0 and .ppid1Zombies == 0 and .helpers == 1 and .sshClients == 0' >/dev/null; then
    print_error "API image retained closed OpenSSH masters: $SSH_REAPING_REPORT"
    exit 1
fi
print_success "API image reaped every closed OpenSSH master ($SSH_REAPING_REPORT)"
