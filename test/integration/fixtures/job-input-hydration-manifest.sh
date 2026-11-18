#!/bin/sh
set -eu
count=$(find /mnt/input/shards -type f | wc -l | tr -d " ")
bytes=$(find /mnt/input/shards -type f -exec stat -c %s {} + | awk '{ total += $1 } END { printf "%.0f", total }')
first=$(sha256sum /mnt/input/shards/0000.bin | awk '{print $1}')
middle=$(sha256sum /mnt/input/shards/1024.bin | awk '{print $1}')
last=$(sha256sum /mnt/input/shards/2047.bin | awk '{print $1}')
test "$count" = "$EXPECTED_SHARD_COUNT"
test "$bytes" = "$EXPECTED_INPUT_BYTES"
test "$first" = "$EXPECTED_SEED_SHA256"
test "$middle" = "$EXPECTED_SEED_SHA256"
test "$last" = "$EXPECTED_SEED_SHA256"
mkdir -p /mnt/output
printf "count=%s\nbytes=%s\nfirst=%s\nmiddle=%s\nlast=%s\n" "$count" "$bytes" "$first" "$middle" "$last" > /mnt/output/manifest.txt
