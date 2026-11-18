import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { LOCAL_SMOLVM_CONTRACT } from '../../src/api/services/gateways/local-smolvm-contract.js';
import { buildLocalSmolvmRunnerImageScript } from './local-smolvm-runner-image.js';

const LOCAL_RUNTIME_DIR = dirname(LOCAL_SMOLVM_CONTRACT.runnerSidecarPath);
const LOCAL_SMOLVM_DATA_DIR = `${LOCAL_RUNTIME_DIR}/runtime`;
const LOCAL_RUNNER_SIDECAR = LOCAL_SMOLVM_CONTRACT.runnerSidecarPath;
const LOCAL_RUNNER_BASE = runnerBasePath(LOCAL_RUNNER_SIDECAR);
const LOCAL_SMOLVM_SERVICE = 'anycloud-test-smolvm.service';

const SMOLVM_LINUX_X86_64_SHA256 =
  'ef706143545b08801f31d447b1a45edaaad08c2733199bb8c10ef6dc2a50e40a';
const SMOLVM_LINUX_ARM64_SHA256 =
  '04b67ec1905aa02fc0d0028f119d29c501502d73a9db6714436456c4fc0e4db7';

const LOCAL_SMOLVM_RUNNER_BUILD_SHAPE = {
  cpus: 2,
  memoryMb: 1024,
  overlayGb: 4,
  storageGb: 4,
} as const;

export interface LocalSmolvmRunnerBuildInput {
  smolvmVersion: string;
  runnerVersion: string;
  cpus: number;
  memoryMb: number;
  overlayGb: number;
  storageGb: number;
  imageScript: string;
}

function runnerBasePath(sidecarPath: string): string {
  const suffix = '.smolmachine';
  if (!sidecarPath.endsWith(suffix)) {
    throw new Error(`Local runner sidecar must end in ${suffix}`);
  }
  return sidecarPath.slice(0, -suffix.length);
}

/** Content key for every input that determines the packed runner artifact. */
export function localSmolvmRunnerBuildFingerprint(
  input: LocalSmolvmRunnerBuildInput,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'anycloud-local-smolvm-runner-build-v1',
        input.smolvmVersion,
        input.runnerVersion,
        input.cpus,
        input.memoryMb,
        input.overlayGb,
        input.storageGb,
        input.imageScript,
      ]),
    )
    .digest('hex');
}

/** Build the user-mode host setup used only by Local integration-test lanes. */
export function buildLocalSmolvmRuntimeSetupScript(): string {
  const runnerImageScript = buildLocalSmolvmRunnerImageScript();
  const runnerBuildFingerprint = localSmolvmRunnerBuildFingerprint({
    smolvmVersion: LOCAL_SMOLVM_CONTRACT.supportedVersion,
    runnerVersion: LOCAL_SMOLVM_CONTRACT.runnerVersion,
    ...LOCAL_SMOLVM_RUNNER_BUILD_SHAPE,
    imageScript: runnerImageScript,
  });

  return `#!/bin/sh
set -eux

SMOLVM_VERSION='${LOCAL_SMOLVM_CONTRACT.supportedVersion}'
STATE_DIR='${LOCAL_RUNTIME_DIR}'
SMOLVM_DATA_DIR='${LOCAL_SMOLVM_DATA_DIR}'
BUCKET_ROOT='${LOCAL_SMOLVM_CONTRACT.bucketHostPath}'
RUNNER_BASE='${LOCAL_RUNNER_BASE}'
RUNNER_SIDECAR='${LOCAL_RUNNER_SIDECAR}'
RUNNER_VERSION='${LOCAL_SMOLVM_CONTRACT.runnerVersion}'
RUNNER_BUILD_FINGERPRINT='${runnerBuildFingerprint}'
RUNNER_CACHE_KEY_FILE="$RUNNER_BASE.version"
RUNNER_DIGEST_FILE="$RUNNER_SIDECAR.sha256"
SMOLVM_PORT='${LOCAL_SMOLVM_CONTRACT.port}'
SERVICE_NAME='${LOCAL_SMOLVM_SERVICE}'
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
SMOLVM_BASE="$STATE_DIR/smolvm-$SMOLVM_VERSION"
PACK_STAGING="$STATE_DIR/pack-staging"
RUN_UID=$(id -u)
RUN_GID=$(id -g)
RUN_USER=$(id -un)
RUN_GROUP=$(id -gn)

if [ "$RUN_UID" -eq 0 ]; then
  echo "Local smolvm setup must run as an unprivileged user, not root." >&2
  exit 43
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo "Local smolvm setup needs sudo only to prepare its host directories and service." >&2
  exit 43
fi

# Keep the fixed path visible at the same location in the runner and its private
# Docker daemon. Only this bounded preparation is privileged; every smolvm
# command below runs as the invoking user.
sudo install -d -m 0755 -o "$RUN_UID" -g "$RUN_GID" \
  "$STATE_DIR" "$SMOLVM_DATA_DIR" "$SMOLVM_BASE" "$BUCKET_ROOT" "$PACK_STAGING"
sudo chown -R "$RUN_UID:$RUN_GID" "$SMOLVM_BASE"
sudo find "$STATE_DIR" -maxdepth 1 -type f -name 'runner-cow-v1*' \
  -exec chown "$RUN_UID:$RUN_GID" {} +
chmod 0777 "$BUCKET_ROOT"
export SMOLVM_DATA_DIR

case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    ASSET="smolvm-$SMOLVM_VERSION-linux-x86_64.tar.gz"
    ASSET_DIR="smolvm-$SMOLVM_VERSION-linux-x86_64"
    CHECKSUM="${SMOLVM_LINUX_X86_64_SHA256}"
    ;;
  Linux:aarch64|Linux:arm64)
    ASSET="smolvm-$SMOLVM_VERSION-linux-arm64.tar.gz"
    ASSET_DIR="smolvm-$SMOLVM_VERSION-linux-arm64"
    CHECKSUM="${SMOLVM_LINUX_ARM64_SHA256}"
    ;;
  *)
    echo "Unsupported smolvm host platform: $(uname -s) $(uname -m)" >&2
    exit 42
    ;;
esac

if [ ! -e /dev/kvm ] || [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  echo "The Local test harness requires readable/writable /dev/kvm." >&2
  exit 44
fi

ARCHIVE="$SMOLVM_BASE/$ASSET"
SMOLVM="$SMOLVM_BASE/$ASSET_DIR/smolvm"
BUILD_VM=''
VALIDATE_VM=''
GUEST_BOOTSTRAP_FILE=''
SERVICE_TEMP=''

cleanup_setup() {
  if [ -n "$GUEST_BOOTSTRAP_FILE" ]; then
    rm -f "$GUEST_BOOTSTRAP_FILE"
  fi
  if [ -n "$BUILD_VM" ]; then
    "$SMOLVM" machine stop --name "$BUILD_VM" >/dev/null 2>&1 || true
    "$SMOLVM" machine delete --name "$BUILD_VM" --force >/dev/null 2>&1 || true
  fi
  if [ -n "$VALIDATE_VM" ]; then
    "$SMOLVM" machine stop --name "$VALIDATE_VM" >/dev/null 2>&1 || true
    "$SMOLVM" machine delete --name "$VALIDATE_VM" --force >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVICE_TEMP" ]; then
    rm -f "$SERVICE_TEMP"
  fi
}
trap cleanup_setup EXIT

if [ ! -x "$SMOLVM" ]; then
  TEMP_ARCHIVE=$(mktemp "$SMOLVM_BASE/.smolvm-download.XXXXXX")
  curl -fL --retry 5 --retry-delay 2 --retry-all-errors \
    "https://github.com/smol-machines/smolvm/releases/download/v$SMOLVM_VERSION/$ASSET" \
    -o "$TEMP_ARCHIVE"
  echo "$CHECKSUM  $TEMP_ARCHIVE" | sha256sum -c -
  mv "$TEMP_ARCHIVE" "$ARCHIVE"
  tar -xzf "$ARCHIVE" -C "$SMOLVM_BASE"
fi
"$SMOLVM" --version | grep "smolvm $SMOLVM_VERSION"

runner_is_current() {
  [ -f "$RUNNER_SIDECAR" ] || return 1
  [ "$(cat "$RUNNER_CACHE_KEY_FILE" 2>/dev/null || true)" = "$RUNNER_BUILD_FINGERPRINT" ] || return 1
  [ -f "$RUNNER_DIGEST_FILE" ] || return 1
  (cd "$(dirname "$RUNNER_SIDECAR")" && sha256sum -c "$(basename "$RUNNER_DIGEST_FILE")")
}

if ! runner_is_current; then
  rm -f "$RUNNER_BASE" "$RUNNER_SIDECAR" "$RUNNER_CACHE_KEY_FILE" "$RUNNER_DIGEST_FILE"
  BUILD_VM="ac-local-runner-build-$(date +%s)-$$"
  "$SMOLVM" machine create \
    --name "$BUILD_VM" \
    --net \
    --net-backend virtio-net \
    --cpus ${LOCAL_SMOLVM_RUNNER_BUILD_SHAPE.cpus} \
    --mem ${LOCAL_SMOLVM_RUNNER_BUILD_SHAPE.memoryMb} \
    --overlay ${LOCAL_SMOLVM_RUNNER_BUILD_SHAPE.overlayGb} \
    --storage ${LOCAL_SMOLVM_RUNNER_BUILD_SHAPE.storageGb}
  "$SMOLVM" machine start --name "$BUILD_VM"

  GUEST_BOOTSTRAP_FILE=$(mktemp "$STATE_DIR/.guest-bootstrap.XXXXXX")
  cat > "$GUEST_BOOTSTRAP_FILE" <<'GUEST'
${runnerImageScript}
GUEST
  "$SMOLVM" machine exec --name "$BUILD_VM" -- sh -lc "$(cat "$GUEST_BOOTSTRAP_FILE")"
  rm -f "$GUEST_BOOTSTRAP_FILE"
  GUEST_BOOTSTRAP_FILE=''
  "$SMOLVM" machine stop --name "$BUILD_VM"

  TMP_BASE="$RUNNER_BASE.tmp.$$"
  rm -f "$TMP_BASE" "$TMP_BASE.smolmachine"
  SMOLVM_PACK_STAGING="$PACK_STAGING" "$SMOLVM" pack create --from-vm "$BUILD_VM" -o "$TMP_BASE"
  mv "$TMP_BASE" "$RUNNER_BASE"
  mv "$TMP_BASE.smolmachine" "$RUNNER_SIDECAR"
  printf '%s\\n' "$RUNNER_BUILD_FINGERPRINT" > "$RUNNER_CACHE_KEY_FILE"
  (cd "$(dirname "$RUNNER_SIDECAR")" && sha256sum "$(basename "$RUNNER_SIDECAR")" > "$(basename "$RUNNER_DIGEST_FILE")")
  chmod 0444 "$RUNNER_SIDECAR" "$RUNNER_CACHE_KEY_FILE" "$RUNNER_DIGEST_FILE"
  "$SMOLVM" machine delete --name "$BUILD_VM" --force >/dev/null 2>&1 || true
  BUILD_VM=''
fi
runner_is_current
"$SMOLVM" pack run --sidecar "$RUNNER_SIDECAR" --info

# Fail setup before starting Serve if this SmolVM build cannot cold-restore the
# packed cluster and storage disks. This also materializes the immutable bases once
# so the measured workload burst begins with metadata-only private overlays.
VALIDATE_VM="ac-local-runner-validate-$(date +%s)-$$"
"$SMOLVM" machine create \
  --name "$VALIDATE_VM" \
  --from "$RUNNER_SIDECAR" \
  --cpus 1 \
  --mem 512 \
  --overlay 4 \
  --storage 4
"$SMOLVM" machine start --name "$VALIDATE_VM"
if ! "$SMOLVM" machine exec --name "$VALIDATE_VM" -- sh -lc \
  "grep -qx '$RUNNER_VERSION' /etc/anycloud-image-version && test -d /storage/docker && test -s /etc/docker/daemon.json && command -v docker >/dev/null && command -v rclone >/dev/null"; then
  echo "SmolVM $SMOLVM_VERSION cannot restore the prepared image's cluster and storage disks; use a build containing COW VM-mode create --from support." >&2
  exit 45
fi
if ! "$SMOLVM" machine exec --name "$VALIDATE_VM" -- sh -lc \
  "set -eu
rm -f /var/run/docker.pid /var/run/docker.sock
rm -rf /var/run/docker/containerd
dockerd >/tmp/dockerd-validation.log 2>&1 &
for retry in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info --format '{{.Driver}} {{.DockerRootDir}}' | grep -Fx 'overlay2 /storage/docker'
docker image inspect busybox:1.36 >/dev/null"; then
  "$SMOLVM" machine exec --name "$VALIDATE_VM" -- sh -lc \
    "cat /tmp/dockerd-validation.log 2>/dev/null || true" >&2 || true
  echo "The cold-restored runner's pinned Docker state failed validation." >&2
  exit 46
fi
"$SMOLVM" machine stop --name "$VALIDATE_VM"
"$SMOLVM" machine delete --name "$VALIDATE_VM" --force
VALIDATE_VM=''

if command -v systemctl >/dev/null 2>&1 && [ "$(ps -p 1 -o comm= 2>/dev/null || true)" = "systemd" ]; then
  SERVICE_TEMP="$STATE_DIR/.smolvm-service.$$"
  cat > "$SERVICE_TEMP" <<UNIT
[Unit]
Description=AnyCloud Local test smolvm runtime
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Group=$RUN_GROUP
Environment=SMOLVM_LIB_DIR=$SMOLVM_BASE/$ASSET_DIR/lib
Environment=SMOLVM_DATA_DIR=$SMOLVM_DATA_DIR
Environment=SMOLVM_PUBLISH_ADDR=${LOCAL_SMOLVM_CONTRACT.host}
ExecStart=$SMOLVM serve start -l ${LOCAL_SMOLVM_CONTRACT.host}:$SMOLVM_PORT
Restart=always
RestartSec=2
WorkingDirectory=$SMOLVM_BASE/$ASSET_DIR

[Install]
WantedBy=multi-user.target
UNIT
  sudo install -m 0644 "$SERVICE_TEMP" "$SERVICE_PATH"
  rm -f "$SERVICE_TEMP"
  SERVICE_TEMP=''
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
else
  if ! pgrep -u "$RUN_UID" -f "$SMOLVM serve start -l ${LOCAL_SMOLVM_CONTRACT.host}:$SMOLVM_PORT" >/dev/null 2>&1; then
    env SMOLVM_LIB_DIR="$SMOLVM_BASE/$ASSET_DIR/lib" SMOLVM_DATA_DIR="$SMOLVM_DATA_DIR" SMOLVM_PUBLISH_ADDR="${LOCAL_SMOLVM_CONTRACT.host}" nohup "$SMOLVM" serve start -l "${LOCAL_SMOLVM_CONTRACT.host}:$SMOLVM_PORT" > "$STATE_DIR/smolvm-serve.log" 2>&1 &
  fi
fi

for i in $(seq 1 60); do
  if HEALTH="$(curl -fsS "${LOCAL_SMOLVM_CONTRACT.baseUrl}/health")"; then
    printf '%s\\n' "$HEALTH"
    break
  fi
  sleep 1
done
curl -fsS "${LOCAL_SMOLVM_CONTRACT.baseUrl}/health" >/dev/null
`;
}
