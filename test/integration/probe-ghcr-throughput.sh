#!/usr/bin/env bash
# GHCR blob throughput probe — runs ON an Azure GPU VM host (via `cli_exec --vm`).
#
# Decides the one question that gates the whole GPU cold-start plan: is the
# ~15 MB/s container-image pull ceiling on these VMs a PER-CONNECTION cap (a
# single TCP flow is shaped, so N parallel range GETs recover throughput ->
# intra-layer parallel pull is worth building) or a PER-IP / total cap (the wire
# itself is stuck, so parallelism plateaus -> pivot to shrinking bytes and the
# compute side). It pulls a bounded sample of a real image layer at concurrency
# 1, 4, 8, 16 straight from the registry CDN and reports MB/s at each.
#
# Deliberately pure-curl (no jq/aria2c) so it runs on a bare host image. Every
# result line is prefixed `PROBE ` so the caller can grep it out of SSH stdout.
# It never touches Docker/containerd: this isolates the NETWORK path from the
# pull client, so a fast single stream here would instead indict the client.
set -euo pipefail

IMAGE_REF="${1:?usage: probe <image_ref> <layer_digest|auto> [sample_bytes] [ladder]}"
LAYER_DIGEST="${2:-auto}"
# 256 MiB: past TCP slow-start yet small enough to finish under any NAT/LB idle
# timeout even on a badly shaped link (256 MiB / 2 MB/s ~= 128s).
SAMPLE_BYTES="${3:-268435456}"
LADDER="${4:-1 4 8 16}"

emit() { printf 'PROBE %s\n' "$*"; }

# --- parse ghcr.io/<repo>@sha256:... or ghcr.io/<repo>:tag ---
REGISTRY="${IMAGE_REF%%/*}"
REPO="${IMAGE_REF#*/}"; REPO="${REPO%@*}"; REPO="${REPO%:*}"
case "$IMAGE_REF" in
  *@*) REFERENCE="${IMAGE_REF##*@}" ;;
  *:*) REFERENCE="${IMAGE_REF##*:}" ;;
  *)   REFERENCE="latest" ;;
esac
V2="https://${REGISTRY}/v2/${REPO}"

# --- Tier 0 environment fingerprint (removes mis-config as a rival explanation) ---
emit "fingerprint kernel=$(uname -r) nproc=$(nproc)"
emit "fingerprint containerd=$(containerd --version 2>/dev/null | awk '{print $3}' || echo NA) docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo NA)"
emit "fingerprint gpu=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' | tr ',' '/' || echo NA)"
emit "fingerprint nic=$(ip -br addr 2>/dev/null | awk '$1!="lo"{printf "%s:%s ",$1,$3}' || echo NA)"
emit "target image=$IMAGE_REF repo=$REPO ref=$REFERENCE"

# --- anonymous pull token (public repo) ---
TOKEN=$(curl -fsS "https://${REGISTRY}/token?scope=repository:${REPO}:pull&service=${REGISTRY}" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || TOKEN=""
[ -n "$TOKEN" ] || { emit "error=no_pull_token"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")
ACCEPT="application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json"

# --- resolve the layer to sample: the largest, unless one was passed in ---
if [ "$LAYER_DIGEST" = auto ]; then
  command -v python3 >/dev/null 2>&1 || { emit "error=auto_digest_needs_python3"; exit 1; }
  LAYER_DIGEST=$(curl -fsS "${AUTH[@]}" -H "Accept: $ACCEPT" "${V2}/manifests/${REFERENCE}" \
    | python3 -c '
import sys, json, urllib.request
reg, repo, tok = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(sys.stdin)
def fetch(ref):
    req = urllib.request.Request(
        f"https://{reg}/v2/{repo}/manifests/{ref}",
        headers={"Authorization": f"Bearer {tok}",
                 "Accept": "application/vnd.oci.image.manifest.v1+json"})
    return json.load(urllib.request.urlopen(req))
if "manifests" in m:  # multi-arch index -> pick linux/amd64
    d = [x for x in m["manifests"]
         if x.get("platform", {}).get("architecture") == "amd64"][0]["digest"]
    m = fetch(d)
print(max(m["layers"], key=lambda l: l["size"])["digest"])
' "$REGISTRY" "$REPO" "$TOKEN") || LAYER_DIGEST=""
fi
[ -n "$LAYER_DIGEST" ] || { emit "error=no_layer_digest"; exit 1; }
BLOB="${V2}/blobs/${LAYER_DIGEST}"

# --- follow the registry 307 to the pre-signed CDN URL; ranges then need no auth ---
CDN=$(curl -fsS -o /dev/null -w '%{redirect_url}' "${AUTH[@]}" "$BLOB") || CDN=""
if [ -n "$CDN" ]; then FETCH=("$CDN"); else FETCH=("${AUTH[@]}" "$BLOB"); fi

# --- blob size via a 1-byte ranged GET (also proves the CDN honours Range) ---
CR=$(curl -fsS -r 0-0 -D - -o /dev/null "${FETCH[@]}" \
  | awk 'tolower($1)=="content-range:"{gsub(/\r/,"");print $NF}') || CR=""
BLOB_BYTES="${CR##*/}"
[[ "$BLOB_BYTES" =~ ^[0-9]+$ ]] || { emit "error=no_range_support cr=${CR:-none}"; exit 1; }
SAMPLE=$SAMPLE_BYTES; [ "$SAMPLE" -gt "$BLOB_BYTES" ] && SAMPLE=$BLOB_BYTES
emit "blob digest=$LAYER_DIGEST bytes=$BLOB_BYTES sample_bytes=$SAMPLE"

# --- heartbeat: keep SSH stdout flowing so a slow link can't look idle ---
( while true; do sleep 15; printf 'PROBE heartbeat\n'; done ) &
HB=$!
trap 'kill "$HB" 2>/dev/null || true' EXIT

fetch_range() {  # start end -> /dev/null, one retry
  local s=$1 e=$2
  curl -fsS -o /dev/null --range "${s}-${e}" "${FETCH[@]}" \
    || curl -fsS -o /dev/null --range "${s}-${e}" "${FETCH[@]}"
}

read -ra LADDER_ARR <<< "$LADDER"
has_single_stream=0
for N in "${LADDER_ARR[@]}"; do
  [[ "$N" =~ ^[0-9]+$ ]] && [ "$N" -ge 1 ] || { emit "error=invalid_ladder value=$N"; exit 1; }
  [ "$N" = 1 ] && has_single_stream=1
done
[ "$has_single_stream" -eq 1 ] || { emit "error=ladder_needs_single_stream"; exit 1; }

base_mbps=0 best_mbps=0 best_n=0 all_ok=1 window_start=0
for N in "${LADDER_ARR[@]}"; do
  # Use a fresh sample window for each rung so an edge-cache fill by the
  # single-stream run cannot masquerade as a gain from parallelism.
  [ $((window_start + SAMPLE)) -gt "$BLOB_BYTES" ] && window_start=0
  window_end=$(( window_start + SAMPLE - 1 ))
  chunk=$(( (SAMPLE + N - 1) / N ))
  pids=()
  t0=$(date +%s.%N)
  for ((i = 0; i < N; i++)); do
    s=$(( window_start + i * chunk )); e=$(( s + chunk - 1 ))
    [ "$e" -ge "$window_end" ] && e=$window_end
    [ "$s" -le "$e" ] || break
    fetch_range "$s" "$e" &
    pids+=("$!")
  done
  ok=1
  for p in "${pids[@]}"; do wait "$p" || ok=0; done
  t1=$(date +%s.%N)
  mbps=$(awk -v b="$SAMPLE" -v a="$t0" -v z="$t1" 'BEGIN{d=z-a; if(d<=0)d=0.001; printf "%.2f",(b/1048576)/d}')
  secs=$(awk -v a="$t0" -v z="$t1" 'BEGIN{d=z-a; if(d<0)d=0; printf "%.1f",d}')
  emit "ladder n=$N mbps=$mbps seconds=$secs offset=$window_start ok=$ok"
  [ "$ok" -eq 1 ] || all_ok=0
  [ "$N" = 1 ] && base_mbps=$mbps
  awk -v m="$mbps" -v b="$best_mbps" 'BEGIN{exit !(m>b)}' && { best_mbps=$mbps; best_n=$N; }
  window_start=$(( window_start + SAMPLE ))
  sleep 2
done

[ "$all_ok" -eq 1 ] || { emit "error=incomplete_range_download"; exit 1; }
emit "summary single_stream_mbps=$base_mbps best_mbps=$best_mbps best_n=$best_n"
awk -v base="$base_mbps" -v best="$best_mbps" 'BEGIN{
  r = (base>0) ? best/base : 0;
  if (r>=2.0)      { v="PER_CONNECTION_CAP";      note="parallel range GETs recover throughput; build intra-layer parallel pull"; }
  else if (r>=1.3) { v="PARTIAL_PARALLEL_GAIN";   note="some parallel gain; sweep more connections before committing"; }
  else             { v="PER_IP_OR_TOTAL_CAP";     note="transport stuck regardless of parallelism; pivot to byte-shrink + compute-side"; }
  printf "PROBE verdict %s ratio=%.2f note=%s\n", v, r, note;
}'
