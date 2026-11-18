# The provider-transfer guest; run.ts prepends its SPIKE_* settings.
# For each storage in turn: stage the input, upload a checkpoint, restore it.
shutdown -h +"$SPIKE_DEADLINE_MIN"
# Transfers stop 3 minutes before the halt, so the evidence still uploads.
end_by=$(($(date +%s) + (SPIKE_DEADLINE_MIN - 3) * 60))
exec > >(tee /var/log/spike.log /dev/console) 2>&1
set -u
work=/var/spike
mkdir -p "$work/logs" && cd "$work" || exit 1
upload() {
  cp /var/log/spike.log logs/
  tar czf /var/spike.tgz -C "$work" meta results.tsv rtt.tsv logs
  curl -sf --retry 5 -X PUT -H 'Content-Type: application/gzip' \
    --upload-file /var/spike.tgz "$SPIKE_EVIDENCE_URL"
  shutdown -h now
}
touch results.tsv rtt.tsv
trap upload EXIT
{
  echo "target=$SPIKE_TARGET"
  echo "cpus=$(nproc)"
  echo "memKiB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  echo "booted=$(date +%s.%N)"
} > meta

curl -sfL --retry 5 "$SPIKE_RCLONE_URL" -o rclone.zip &&
  echo "$SPIKE_RCLONE_SHA256  rclone.zip" | sha256sum -c - &&
  python3 -m zipfile -e rclone.zip . &&
  install -m 755 "$SPIKE_RCLONE_DIR/rclone" /usr/local/bin/rclone ||
  { echo "SPIKE rclone install failed"; exit 1; }

# Memory, not the worker's disk, holds the data: pool Nodes stage onto local
# NVMe, which outruns these workers' network disks.
mkdir -p data && mount -t tmpfs -o size="${SPIKE_TMPFS_GIB}G" tmpfs data ||
  { echo "SPIKE tmpfs failed"; exit 1; }
mkdir -p data/checkpoint/shards
head -c "${SPIKE_CHECKPOINT_FILE_MIB}M" /dev/urandom > data/checkpoint/model.bin
head -c $((SPIKE_CHECKPOINT_SHARDS * SPIKE_CHECKPOINT_SHARD_KIB))K /dev/urandom |
  split -b "${SPIKE_CHECKPOINT_SHARD_KIB}K" -a 4 -d - data/checkpoint/shards/

# The runner publishes the grants once every input is seeded and re-mints
# them every 20 minutes, so each storage starts with a fresh set.
grants() {
  for _ in $(seq 120); do
    if curl -sf "$SPIKE_GRANTS_URL" -o grants.tgz; then
      rm -rf grants && mkdir grants && tar xzf grants.tgz -C grants && return
    fi
    sleep 15
  done
  return 1
}

# One timed rclone run with the pool runner's flags (src/runner/transfer.ts),
# then the local side's file count and bytes.
transfer() {
  local storage=$1 step=$2 role=$3 verb=$4 from=$5 to=$6 local=$7 start code
  local grant="$work/grants/$storage/$role"
  start=$(date +%s.%N)
  (
    set -a && . "$grant/env" && set +a
    left=$((end_by - $(date +%s)))
    RCLONE_CONFIG="$grant/rclone.conf" timeout $((left > 1 ? left : 1)) \
      rclone "$verb" "$from" "$to" \
      --fast-list --no-update-modtime --modify-window 1s --use-json-log \
      --stats 10s --stats-log-level NOTICE
  ) 2> "logs/$storage-$step.log"
  code=$?
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$storage" "$step" "$start" \
    "$(date +%s.%N)" "$code" "$(find "$local" -type f | wc -l)" \
    "$(find "$local" -type f -printf '%s\n' | awk '{s += $1} END {print s + 0}')" \
    >> results.tsv
}

for storage in $SPIKE_STORAGES; do
  if ((end_by - $(date +%s) < 420)); then
    echo "SPIKE skipped $storage and later storages: deadline"
    break
  fi
  grants || { echo "SPIKE no grants for $storage"; exit 1; }
  host=$(cat "grants/$storage/host")
  for _ in 1 2 3; do
    curl -so /dev/null -w "$storage\t%{time_connect}\n" "https://$host/" >> rtt.tsv
  done
  echo "SPIKE $storage $(date +%s.%N)"
  transfer "$storage" stage input sync "$(cat "grants/$storage/input/remote")" \
    "$work/data/input" "$work/data/input"
  rm -rf data/input
  checkpoint=$(cat "grants/$storage/checkpoint/remote")
  transfer "$storage" checkpoint-upload checkpoint copy "$work/data/checkpoint" \
    "$checkpoint" "$work/data/checkpoint"
  transfer "$storage" checkpoint-restore checkpoint copy "$checkpoint" \
    "$work/data/restore" "$work/data/restore"
  rm -rf data/restore
done
echo "SPIKE complete"
