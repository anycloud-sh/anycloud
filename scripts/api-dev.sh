#!/bin/bash
# Build the API image from the working tree and run it as an isolated dev
# container: anycloud-api-dev on port 8081, data in ~/.anycloud-dev. The real
# `anycloud-api` container (port 8080, ~/.anycloud) is left untouched, so both
# run side by side. This is the loop for testing server-side changes locally —
# `yarn build` alone never updates the running API container.
#
# Usage: yarn api:dev         build + (re)start the dev container (idempotent:
#                              replaces any previous one)
#        yarn api:dev:stop    stop and remove it (data dir kept)
# Then:  yarn cli:dev <cmd>    (sets API_URL=http://localhost:8081)
#
# Hot reload: dist/ and migrations/ are bind-mounted from the working tree and
# the container restarts its server whenever dist/ changes, so after editing
# server code a plain `yarn build` reloads it — no rebuild or rerun needed.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="anycloud-api:dev"
CONTAINER="anycloud-api-dev"
PORT=8081
DATA_DIR="$HOME/.anycloud-dev"
URL="http://localhost:$PORT"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "Stopped $CONTAINER (data kept in $DATA_DIR)"
  exit 0
fi

# Host build so the CLI in dist/ matches the server being tested (lockstep).
yarn build

# Local-only tag; never touches ghcr.io/anycloud-sh/api:*.
docker build -t "$IMAGE" .

mkdir -p "$DATA_DIR"
if [ ! -f "$DATA_DIR/cipher.key" ]; then
  # Mirrors getOrCreateCipherKey (src/cli/commands/api.ts): 32 random bytes, hex.
  openssl rand -hex 32 > "$DATA_DIR/cipher.key"
  chmod 600 "$DATA_DIR/cipher.key"
fi
# The dev API takes the real local API's per-install token, so `yarn cli:dev`,
# which keeps ~/.anycloud, reaches it. Mirrors `anycloud api start` when missing.
TOKEN_FILE="${ANYCLOUD_DIR:-$HOME/.anycloud}/local-api-token"
if [ ! -f "$TOKEN_FILE" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  (umask 077 && openssl rand -hex 32 > "$TOKEN_FILE")
fi
install -m 600 "$TOKEN_FILE" "$DATA_DIR/local-api-token"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Reload supervisor. Mounting dist/ directly can't survive `yarn clean`: the
# bind is tied to the deleted inode, and the container sees an empty dir
# forever after (same reason node --watch wedged). So the worktree is mounted
# read-only at /src — the repo root is never recreated — and the loop copies
# /src/dist (and migrations) into the image filesystem, restarting node when
# the host build output changes and has settled for a tick (1s mtime poll).
# Copying also keeps bare imports resolving to the image's linux node_modules
# instead of walking up into the host's macOS ones.
RELOAD_LOOP='
latest() { find /src/dist -type f -printf "%T@\n" 2>/dev/null | sort -rn | head -1; }
sync_tree() {
  rm -rf /app/dist.next && cp -r /src/dist /app/dist.next &&
    rm -rf /app/dist && mv /app/dist.next /app/dist &&
    rm -rf /app/migrations && cp -r /src/migrations /app/migrations
}
while :; do
  target=$(latest)
  if [ -z "$target" ]; then sleep 1; continue; fi
  sleep 1
  if [ "$(latest)" != "$target" ]; then continue; fi
  sync_tree
  node dist/api/server.js &
  pid=$!
  ran=$target
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    now=$(latest)
    if [ -z "$now" ] || [ "$now" = "$ran" ]; then continue; fi
    sleep 1
    if [ "$(latest)" = "$now" ]; then
      kill "$pid"
      wait "$pid" 2>/dev/null
    fi
  done
done'

# Same args `anycloud api start` uses (src/cli/commands/api.ts), with dev
# values plus the read-only worktree mount and supervisor. node_modules stay
# baked in the image (linux-native deps), so rerun api:dev when deps change.
docker run -d --name "$CONTAINER" \
  -p "$PORT:8080" \
  -v "$DATA_DIR:/root/.anycloud" \
  -v "$PWD:/src:ro" \
  --tmpfs /run/anycloud-ssh:rw,noexec,nosuid,nodev,size=1m,mode=0700 \
  -e PORT=8080 \
  -e SQLITE_PATH=/root/.anycloud/api.db \
  "$IMAGE" sh -c "$RELOAD_LOOP" >/dev/null

echo "Waiting for $URL/health..."
for _ in $(seq 1 60); do
  if curl -fsS "$URL/health" >/dev/null 2>&1; then
    echo "Dev API ready: $CONTAINER ($IMAGE) on $URL"
    echo "Target it with: yarn cli:dev <cmd>"
    exit 0
  fi
  sleep 0.5
done

echo "Dev API did not become healthy; recent logs:" >&2
docker logs "$CONTAINER" 2>&1 | tail -50 >&2
exit 1
