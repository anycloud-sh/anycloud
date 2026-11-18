#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_IMAGE="${1:?Usage: api-ssh-drain.sh <api-image>}"
SSH_DRAIN_SERVER="api-ssh-drain-server-$$"
SSH_DRAIN_CLIENT="api-ssh-drain-client-$$"
SSH_DRAIN_NETWORK="api-ssh-drain-$$"
SSH_DRAIN_SERVER_IMAGE="anycloud-ssh-drain-server-test-$$"
SSH_DRAIN_BUILD_DIR=$(mktemp -d)
SSH_RUNTIME_TMPFS=/run/anycloud-ssh:rw,noexec,nosuid,nodev,size=1m,mode=0700

source "$SCRIPT_DIR/common.sh"

cleanup() {
    docker rm -f "$SSH_DRAIN_CLIENT" "$SSH_DRAIN_SERVER" >/dev/null 2>&1 || true
    docker network rm "$SSH_DRAIN_NETWORK" >/dev/null 2>&1 || true
    docker image rm "$SSH_DRAIN_SERVER_IMAGE" >/dev/null 2>&1 || true
    rm -rf "$SSH_DRAIN_BUILD_DIR"
}

trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$SSH_DRAIN_BUILD_DIR/id_ed25519"
# The peer image is just the API image plus sshd; the reaping test builds the
# same thing from this fixture.
cp "$SCRIPT_DIR/../fixtures/ssh-api-image-reaping.Dockerfile" "$SSH_DRAIN_BUILD_DIR/Dockerfile"
cp "$SSH_DRAIN_BUILD_DIR/id_ed25519.pub" "$SSH_DRAIN_BUILD_DIR/authorized_keys"
retry_cmd 3 15 docker build \
    --build-arg "API_IMAGE=$API_IMAGE" \
    -t "$SSH_DRAIN_SERVER_IMAGE" \
    "$SSH_DRAIN_BUILD_DIR" >/dev/null
docker network create "$SSH_DRAIN_NETWORK" >/dev/null
docker run -d \
    --name "$SSH_DRAIN_SERVER" \
    --network "$SSH_DRAIN_NETWORK" \
    --network-alias ssh-drain-server \
    "$SSH_DRAIN_SERVER_IMAGE" >/dev/null
# No --entrypoint: the image's own init is the thing under test.
docker run -d \
    --name "$SSH_DRAIN_CLIENT" \
    --network "$SSH_DRAIN_NETWORK" \
    --tmpfs "$SSH_RUNTIME_TMPFS" \
    -e CIPHER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    -v "$SSH_DRAIN_BUILD_DIR/id_ed25519:/fixture/id_ed25519:ro" \
    -v "$SCRIPT_DIR/ssh-api-image-drain.mjs:/fixture/drain.mjs:ro" \
    "$API_IMAGE" node /fixture/drain.mjs >/dev/null

SSH_DRAIN_IN_FLIGHT=false
for _ in $(seq 1 60); do
    if docker logs "$SSH_DRAIN_CLIENT" 2>&1 | grep -q '"event":"ssh-drain-in-flight"'; then
        SSH_DRAIN_IN_FLIGHT=true
        break
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$SSH_DRAIN_CLIENT" 2>/dev/null || echo false)" != "true" ]; then
        break
    fi
    sleep 1
done
if [ "$SSH_DRAIN_IN_FLIGHT" != true ]; then
    print_error "API image SSH drain probe never put a command in flight"
    docker logs "$SSH_DRAIN_CLIENT" 2>&1 | tail -30
    exit 1
fi

# What `docker stop` does: SIGTERM to PID 1, while a VM command is mid-flight.
docker exec "$SSH_DRAIN_CLIENT" sh -c 'kill -TERM 1'

SSH_DRAIN_REPORT=""
for _ in $(seq 1 60); do
    SSH_DRAIN_REPORT=$(docker logs "$SSH_DRAIN_CLIENT" 2>&1 | grep '"event":"ssh-drain-result"' || true)
    [ -n "$SSH_DRAIN_REPORT" ] && break
    sleep 1
done
if [ -z "$SSH_DRAIN_REPORT" ]; then
    print_error "API image SSH drain probe never reported an outcome"
    docker logs "$SSH_DRAIN_CLIENT" 2>&1 | tail -30
    exit 1
fi
if ! docker logs "$SSH_DRAIN_CLIENT" 2>&1 | grep -q '"event":"ssh-drain-signalled"'; then
    print_error "Shutdown signal never reached the API process: $SSH_DRAIN_REPORT"
    exit 1
fi
if ! echo "$SSH_DRAIN_REPORT" | \
    jq -e '.exec.status == "completed" and .stream.status == "completed"' >/dev/null; then
    print_error "Shutdown aborted an in-flight VM command: $SSH_DRAIN_REPORT"
    exit 1
fi
print_success "In-flight VM commands survive the API's shutdown signal ($SSH_DRAIN_REPORT)"
