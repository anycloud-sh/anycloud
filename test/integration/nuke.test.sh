#!/usr/bin/env bash

# Nuke Stress Test
#
# Reproduces the production incident for real cloud providers: a large seeded
# production-shaped DB plus a bounded mass-concurrent real cloud overlay. Providers
# use spot and bucket-sync where supported; Lambda intentionally uses a bare
# on-demand workload so the lane isolates launch pressure. Fires NUKE_COUNT tiny
# jobs as fast as possible, runs each through its full lifecycle, then measures
# how many reach `completed` and how fast. The `local` provider is a no-cloud
# smolvm harness lane that is safe for PR CI: it keeps the same seeded DB, submit
# fan-out, status, and memory gates while running each workload on a disposable
# VM host. It intentionally skips spot, credentials, and bucket-sync. Real cloud
# providers remain manual/opt-in through `.github/workflows/nuke.yml`.
#
# Gates: at least NUKE_PASS_PCT% (default 80%) of overlay jobs must reach
# completed, every responsiveness probe and memory gate must pass, and a second
# scheduling lane (an agent session) submitted last must win a provisioning
# slot promptly. Fairness requires
# at least six dispatch windows of backlog; reject smaller runs before setup.
# Continuous HTTP probes require p99 <1s and zero six-second timeouts. Local
# nuke also requires >=2 GiB resident API memory and sustained 24/s SSH pressure.
#
# Assumes a running API (API_URL). Run it via `./e2e.sh nuke` (boots an isolated
# conductor and seeds its DB for you), or point at an existing already-seeded
# local API and pass the seed manifest. A local API answers only on its own
# machine, so run this on the machine that runs it:
#   API_URL=http://localhost:8080 NUKE_DB_MANIFEST=/tmp/nuke-db-manifest.json bash test/integration/nuke.test.sh
#
# Env (all optional; defaults target the shared azure-test account):
#   NUKE_PROVIDER     local | aws | azure | gcp | lambda  (default azure)
#   NUKE_COUNT        number of overlay jobs      (default 300; minimum 300)
#   NUKE_VMTYPE       VM type                     (default per provider)
#   NUKE_IMAGE        workload image              (default alpine; local uses pinned BusyBox 1.36)
#   NUKE_CREDENTIAL   credential name to register (default per provider <cloud>-test)
#   NUKE_DB_MANIFEST  seed nuke-db manifest path  (set by e2e.sh)
#   NUKE_RUNTIME_SEC  seconds each job runs       (default 30)
#   NUKE_PASS_PCT     % of jobs that must complete (default 80; the gate)
#   NUKE_DEADLINE_SEC overall measurement budget   (default 9000)
#   NUKE_CLEANUP_DRAIN_SEC live-VM cleanup ceiling (default 600)
#   NUKE_DB_TIMEOUT_MS API probe and memory sample timeout (default 6000)
#   NUKE_SUBMIT_TIMEOUT_SEC per-submit CLI timeout  (default 600)
#   NUKE_POST_SUBMIT_VISIBILITY_SEC accepted-id list visibility timeout (default 120)
#   NUKE_FAIRNESS_WITNESS_COUNT second-caller jobs submitted last (default 2; minimum 1)
#   NUKE_FAIRNESS_MAX_DISPATCH_SEC witness time-to-leave-queued bar (default 60)
#   NUKE_FAIRNESS_USER     names the witness's agent session (default nuke-witness)
#   NUKE_INTERRUPT_AFTER_WITNESS declared cancellation control (default false)
#   NUKE_MEMORY_SAMPLE_SEC memory sample interval   (default 15)
#   NUKE_MEMORY_WARMUP_SEC slope warmup window      (default 180)
#   NUKE_MAX_RSS_MB    max API process RSS          (default 4096)
#   NUKE_MAX_HEAP_MB   max API V8 heap used         (default 2048)
#   NUKE_MAX_RSS_SLOPE_MB_PER_MIN  post-warmup RSS slope  (default 64)
#   NUKE_MAX_HEAP_SLOPE_MB_PER_MIN post-warmup heap slope (default 32)
#   NUKE_MEMORY_MAX_TRANSIENT_SAMPLE_ERRORS tolerated sampler errors (default 2)
#   NUKE_MEMORY_MAX_CONSECUTIVE_SAMPLE_ERRORS tolerated consecutive sampler errors (default 2)
#   NUKE_MEMORY_MAX_SAMPLE_ERROR_RATE tolerated sampler error rate (default 0.05)
#   NUKE_HOST_SAMPLE_SEC runner host/API-container sample interval (default 10)
#   NUKE_HOST_QUIESCENCE_SEC final process drain ceiling (default 90)
#   NUKE_API_CONTAINER local API container for log capture (default anycloud-api;
#                      set explicitly for non-loopback API_URLs, empty to disable)
#   API_URL           required
#   <cloud> creds     AWS_*/AZURE_*/GCP_* in env, per the chosen real provider
set -e

# Requires bash >= 4 (declare -A, wait -n). macOS ships bash 3.2 as /bin/bash.
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    echo "nuke.test.sh requires bash >= 4 (declare -A / wait -n). On macOS: 'brew install bash' and run it with that bash." >&2
    exit 1
fi

SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export PROJECT_ROOT
cd "$PROJECT_ROOT"

source "$SCRIPT_DIR/helpers/common.sh"
source "$SCRIPT_DIR/helpers/nuke-db.sh"
source "$SCRIPT_DIR/helpers/nuke-list.sh"
source "$SCRIPT_DIR/helpers/nuke-cleanup.sh"

echo "========================================="
echo "Nuke Stress Test"
echo "========================================="

# --- Resolve + guard config -------------------------------------------------
NUKE_PROVIDER="${NUKE_PROVIDER:-azure}"
# The seeded DB supplies the large historical shape; the real cloud overlay stays
# bounded so the gate measures API responsiveness under load without requiring
# thousands of live cloud jobs. Override NUKE_COUNT for larger manual overlays.
NUKE_COUNT="${NUKE_COUNT:-300}"
NUKE_RUNTIME_SEC_WAS_SET="${NUKE_RUNTIME_SEC+x}"
NUKE_DEADLINE_SEC_WAS_SET="${NUKE_DEADLINE_SEC+x}"
NUKE_DB_TIMEOUT_MS_WAS_SET="${NUKE_DB_TIMEOUT_MS+x}"
NUKE_CLEANUP_DRAIN_SEC_WAS_SET="${NUKE_CLEANUP_DRAIN_SEC+x}"
NUKE_RUNTIME_SEC="${NUKE_RUNTIME_SEC:-30}"
# Overall measurement budget (the loop exits early once all N are terminal, so
# this is just a ceiling). Provisioning is 50-wide and a job holds a slot until
# `running` (~5 min); the generous ceiling leaves headroom for seeded DB load,
# a healthy-but-slow overlay, and manual larger overlay runs.
NUKE_DEADLINE_SEC="${NUKE_DEADLINE_SEC:-9000}"
NUKE_CLEANUP_DRAIN_SEC="${NUKE_CLEANUP_DRAIN_SEC:-600}"
NUKE_SUBMIT_TIMEOUT_SEC="${NUKE_SUBMIT_TIMEOUT_SEC:-600}"
NUKE_POST_SUBMIT_VISIBILITY_SEC="${NUKE_POST_SUBMIT_VISIBILITY_SEC:-120}"
# Pass bar: at least this fraction of jobs must reach `completed`. This is a real
# gate (the test FAILS below it), with headroom for spot evictions / transient flakes.
NUKE_PASS_PCT="${NUKE_PASS_PCT:-80}"
# Queue fairness. The witness submits from its own agent session, a scheduling
# lane of its own beside the wall's, sharing the wall's credential and owner.
NUKE_DISPATCH_WINDOW=50   # server-side MAX_ACTIVE_DEPLOY_PIPELINES; not a knob
NUKE_FAIRNESS_WITNESS_COUNT="${NUKE_FAIRNESS_WITNESS_COUNT:-2}"
# Measured on the local lane at NUKE_COUNT=300, timed from the witness's own
# submission: a fair scheduler dispatches it in 0-5s (inside one 5s scheduler
# tick, since the second tenant's lane is empty), an unfair one in at least 115s
# — that figure was taken on the older clock, which started after the post-submit
# checks, so the true unfair wait is longer still. The bar sits between the two
# regimes rather than near either edge, so neither a slow runner nor a fast one
# flips the result.
NUKE_FAIRNESS_MAX_DISPATCH_SEC="${NUKE_FAIRNESS_MAX_DISPATCH_SEC:-60}"
NUKE_FAIRNESS_USER="${NUKE_FAIRNESS_USER:-nuke-witness}"
NUKE_INTERRUPT_AFTER_WITNESS="${NUKE_INTERRUPT_AFTER_WITNESS:-false}"
NUKE_INTERRUPTION_ARMED=false
NUKE_MEMORY_SAMPLE_SEC="${NUKE_MEMORY_SAMPLE_SEC:-15}"
NUKE_MEMORY_WARMUP_SEC="${NUKE_MEMORY_WARMUP_SEC:-180}"
NUKE_MAX_RSS_MB="${NUKE_MAX_RSS_MB:-4096}"
NUKE_MAX_HEAP_MB="${NUKE_MAX_HEAP_MB:-2048}"
NUKE_MAX_RSS_SLOPE_MB_PER_MIN="${NUKE_MAX_RSS_SLOPE_MB_PER_MIN:-64}"
NUKE_MAX_HEAP_SLOPE_MB_PER_MIN="${NUKE_MAX_HEAP_SLOPE_MB_PER_MIN:-32}"
NUKE_MEMORY_MAX_TRANSIENT_SAMPLE_ERRORS="${NUKE_MEMORY_MAX_TRANSIENT_SAMPLE_ERRORS:-2}"
NUKE_MEMORY_MAX_CONSECUTIVE_SAMPLE_ERRORS="${NUKE_MEMORY_MAX_CONSECUTIVE_SAMPLE_ERRORS:-2}"
NUKE_MEMORY_MAX_SAMPLE_ERROR_RATE="${NUKE_MEMORY_MAX_SAMPLE_ERROR_RATE:-0.05}"
NUKE_HOST_SAMPLE_SEC="${NUKE_HOST_SAMPLE_SEC:-10}"
NUKE_HOST_QUIESCENCE_SEC="${NUKE_HOST_QUIESCENCE_SEC:-90}"
# Client-side cap on concurrent `node submit` procs — NOT an API throttle (the API
# caps provisioning at 50 itself); this just stops 1000 node procs OOM-ing the test
# host. Fixed, not a knob: the API's 50 is the natural ceiling.
SUBMIT_PARALLELISM=50
# The harness tracks a run with one filtered `anycloud list` call per poll, and
# the API caps a single list response at 1000 rows (MAX_LIST_LIMIT).
NUKE_HARD_CAP=1000   # not a knob — guards against a false-pass / false-fail run shape

# Per-id terminal outcome populated by the measurement loop for classification
# and reporting.
declare -A FINAL_STATE
declare -a SUBMIT_PIDS
export RESULTS_DIR="${RESULTS_DIR:-/tmp/nuke-${TEST_RUN}}"
NUKE_CLEANUP_RECORD_DIR="$RESULTS_DIR/nuke-cleanup"
API_MEMORY_SAMPLER_PID=""
API_MEMORY_START_TS=""
NUKE_MEMORY_FILE="${NUKE_MEMORY_FILE:-${RESULTS_DIR:-/tmp}/nuke-api-memory.ndjson}"
NUKE_MEMORY_REPORT_FILE="${NUKE_MEMORY_REPORT_FILE:-${RESULTS_DIR:-/tmp}/nuke-memory-report.json}"
NUKE_SUBMIT_LOG_DIR="${NUKE_SUBMIT_LOG_DIR:-${RESULTS_DIR:-/tmp}/nuke-submit}"
NUKE_FINAL_LIST_FILE="${NUKE_FINAL_LIST_FILE:-${RESULTS_DIR:-/tmp}/nuke-final-list.json}"
NUKE_POLL_LIST_FILE="${NUKE_POLL_LIST_FILE:-${RESULTS_DIR:-/tmp}/nuke-poll-list.json}"
NUKE_POLL_ROWS_FILE="${NUKE_POLL_ROWS_FILE:-${RESULTS_DIR:-/tmp}/nuke-poll-list.tsv}"
NUKE_API_LOG_FILE="${NUKE_API_LOG_FILE:-${RESULTS_DIR:-/tmp}/nuke-api.log}"
if [ "${NUKE_API_CONTAINER+x}" = x ]; then
    NUKE_API_CONTAINER_EXPLICIT=true
else
    NUKE_API_CONTAINER_EXPLICIT=false
fi
NUKE_API_CONTAINER="${NUKE_API_CONTAINER-anycloud-api}"
NUKE_CLASSIFICATION_FILE="${NUKE_CLASSIFICATION_FILE:-${RESULTS_DIR:-/tmp}/nuke-classification.json}"
NUKE_RUN_START_ISO=""
NUKE_CLASSIFICATION_EMITTED=false
NUKE_CLASSIFICATION_IN_PROGRESS=false
NUKE_MEMORY_BUDGET_EVALUATED=false
NUKE_MEMORY_BUDGET_RC=0
NUKE_MEMORY_BUDGET_SUMMARY=""
NUKE_MEMORY_SAMPLER_STARTED=false
HOST_SAMPLER_PID=""
HOST_START_TS=""
NUKE_HOST_FILE="${NUKE_HOST_FILE:-${RESULTS_DIR:-/tmp}/nuke-host.ndjson}"
NUKE_HOST_REPORT_FILE="${NUKE_HOST_REPORT_FILE:-${RESULTS_DIR:-/tmp}/nuke-host-report.json}"
NUKE_HOST_METRICS_EVALUATED=false
NUKE_HOST_METRICS_RC=0
NUKE_HOST_METRICS_SUMMARY=""
NUKE_HOST_SAMPLER_STARTED=false
HEALTH_SAMPLER_PID=""
NUKE_HEALTH_RC=0

case "$NUKE_INTERRUPT_AFTER_WITNESS" in
    true|false) ;;
    *) fail "NUKE_INTERRUPT_AFTER_WITNESS must be true or false" ;;
esac

if ! [[ "$NUKE_COUNT" =~ ^[0-9]+$ ]] || [ "$NUKE_COUNT" -lt 1 ]; then
    fail "NUKE_COUNT must be a positive integer (got '$NUKE_COUNT')"
fi
if ! [[ "$NUKE_PASS_PCT" =~ ^[0-9]+$ ]] || [ "$NUKE_PASS_PCT" -lt 1 ] || [ "$NUKE_PASS_PCT" -gt 100 ]; then
    fail "NUKE_PASS_PCT must be an integer from 1 to 100 (got '$NUKE_PASS_PCT')"
fi
if [ "$NUKE_COUNT" -gt "$NUKE_HARD_CAP" ]; then
    fail "NUKE_COUNT=$NUKE_COUNT exceeds the nuke harness cap ($NUKE_HARD_CAP). The harness relies on one filtered anycloud list response per poll, and the API caps that response at $NUKE_HARD_CAP rows. Larger runs need public list pagination."
fi
# The witness's FIFO wait is roughly (NUKE_COUNT / window - 1) x wave-time, so a
# queue merely deeper than the window drains past it almost at once: measured on
# the local lane, an unfair scheduler served the witness in 40s at NUKE_COUNT=120
# but took 115s at 300. The wall has to stay deeper than the free-slot count for
# longer than the bar, which takes several windows of depth.
NUKE_FAIRNESS_MIN_COUNT=$(( NUKE_DISPATCH_WINDOW * 6 ))
if [ "$NUKE_COUNT" -lt "$NUKE_FAIRNESS_MIN_COUNT" ]; then
    fail "NUKE_COUNT must be at least $NUKE_FAIRNESS_MIN_COUNT to exercise queue fairness (got '$NUKE_COUNT')"
fi
if ! [[ "$NUKE_FAIRNESS_WITNESS_COUNT" =~ ^[0-9]+$ ]] || [ "$NUKE_FAIRNESS_WITNESS_COUNT" -lt 1 ]; then
    fail "NUKE_FAIRNESS_WITNESS_COUNT must be a positive integer (got '$NUKE_FAIRNESS_WITNESS_COUNT')"
fi
if ! [[ "$NUKE_FAIRNESS_MAX_DISPATCH_SEC" =~ ^[0-9]+$ ]] || [ "$NUKE_FAIRNESS_MAX_DISPATCH_SEC" -lt 1 ]; then
    fail "NUKE_FAIRNESS_MAX_DISPATCH_SEC must be a positive integer (got '$NUKE_FAIRNESS_MAX_DISPATCH_SEC')"
fi
if ! [[ "$NUKE_MEMORY_SAMPLE_SEC" =~ ^[0-9]+$ ]] || [ "$NUKE_MEMORY_SAMPLE_SEC" -lt 1 ]; then
    fail "NUKE_MEMORY_SAMPLE_SEC must be a positive integer (got '$NUKE_MEMORY_SAMPLE_SEC')"
fi
if ! [[ "$NUKE_MEMORY_WARMUP_SEC" =~ ^[0-9]+$ ]]; then
    fail "NUKE_MEMORY_WARMUP_SEC must be a non-negative integer (got '$NUKE_MEMORY_WARMUP_SEC')"
fi
if ! [[ "$NUKE_HOST_SAMPLE_SEC" =~ ^[0-9]+$ ]] || [ "$NUKE_HOST_SAMPLE_SEC" -lt 1 ]; then
    fail "NUKE_HOST_SAMPLE_SEC must be a positive integer (got '$NUKE_HOST_SAMPLE_SEC')"
fi
if ! [[ "$NUKE_HOST_QUIESCENCE_SEC" =~ ^[0-9]+$ ]]; then
    fail "NUKE_HOST_QUIESCENCE_SEC must be a non-negative integer (got '$NUKE_HOST_QUIESCENCE_SEC')"
fi
if ! [[ "$NUKE_SUBMIT_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || [ "$NUKE_SUBMIT_TIMEOUT_SEC" -lt 1 ]; then
    fail "NUKE_SUBMIT_TIMEOUT_SEC must be a positive integer (got '$NUKE_SUBMIT_TIMEOUT_SEC')"
fi
if ! [[ "$NUKE_POST_SUBMIT_VISIBILITY_SEC" =~ ^[0-9]+$ ]]; then
    fail "NUKE_POST_SUBMIT_VISIBILITY_SEC must be a non-negative integer (got '$NUKE_POST_SUBMIT_VISIBILITY_SEC')"
fi
if ! [[ "$NUKE_CLEANUP_DRAIN_SEC" =~ ^[0-9]+$ ]]; then
    fail "NUKE_CLEANUP_DRAIN_SEC must be a non-negative integer (got '$NUKE_CLEANUP_DRAIN_SEC')"
fi

SUBMIT_TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
    SUBMIT_TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
    SUBMIT_TIMEOUT_CMD="gtimeout"
else
    fail "GNU timeout/gtimeout is required for bounded nuke submit calls"
fi

# Provider dispatch: pick the cloud helper (for its delete fn), build the creds
# JSON via require_*_credentials (NO cloud-CLI login needed — all bucket ops go
# through cli_bucket/the API), and set the per-provider defaults. `local` is a
# no-cloud lane: it uses disposable smolvm VM hosts and intentionally skips
# cloud credentials, spot, and bucket-sync.
NUKE_IS_LOCAL=false
NUKE_USES_BUCKET_SYNC=true
NUKE_USES_SPOT=true
DEFAULT_IMAGE="alpine"
case "$NUKE_PROVIDER" in
    local)
        NUKE_IS_LOCAL=true
        NUKE_USES_BUCKET_SYNC=false
        NUKE_USES_SPOT=false
        RAW_CREDS_JSON=""
        DEFAULT_VMTYPE="local"; DEFAULT_CRED=""
        DELETE_BUCKET_FN=""; PER_HR="0"
        # Use the immutable image already prepared by the Local runner.
        DEFAULT_IMAGE="mirror.gcr.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"
        ;;
    azure)
        source "$SCRIPT_DIR/helpers/azure-blob.sh"
        require_azure_credentials
        RAW_CREDS_JSON="$AZURE_CREDENTIALS_JSON"
        DEFAULT_VMTYPE="Standard_D2as_v5"; DEFAULT_CRED="azure-test"
        DELETE_BUCKET_FN="delete_azure_container"; PER_HR="0.0268"
        ;;
    aws)
        source "$SCRIPT_DIR/helpers/aws-s3.sh"
        require_aws_credentials
        RAW_CREDS_JSON="$AWS_CREDENTIALS_JSON"
        DEFAULT_VMTYPE="t3.large"; DEFAULT_CRED="aws-test"
        DELETE_BUCKET_FN="delete_s3_bucket"; PER_HR="0.0398"
        ;;
    lambda)
        # Lambda is compute-only and has no spot pool. This bare lane isolates
        # launch pressure and the reactive HTTP 429 policy from bucket work.
        require_lambda_credentials
        RAW_CREDS_JSON="$LAMBDA_CREDENTIALS_JSON"
        NUKE_USES_BUCKET_SYNC=false
        NUKE_USES_SPOT=false
        DEFAULT_VMTYPE="gpu_1x_a10"; DEFAULT_CRED="lambda-test"
        DELETE_BUCKET_FN=""; PER_HR="1.29"
        ;;
    gcp)
        source "$SCRIPT_DIR/helpers/gcp-gcs.sh"
        require_gcp_credentials
        RAW_CREDS_JSON="$GCP_CREDENTIALS_JSON"
        DEFAULT_VMTYPE="e2-standard-2"; DEFAULT_CRED="gcp-test"
        DELETE_BUCKET_FN="delete_gcs_bucket"; PER_HR="0.0390"
        ;;
    *)
        fail "Unknown NUKE_PROVIDER '$NUKE_PROVIDER' (expected local|aws|azure|gcp|lambda)"
        ;;
esac
NUKE_VMTYPE="${NUKE_VMTYPE:-$DEFAULT_VMTYPE}"
NUKE_CREDENTIAL="${NUKE_CREDENTIAL:-$DEFAULT_CRED}"
NUKE_IMAGE="${NUKE_IMAGE:-$DEFAULT_IMAGE}"
if [ "$NUKE_IS_LOCAL" = true ]; then
    [ -z "$NUKE_RUNTIME_SEC_WAS_SET" ] && NUKE_RUNTIME_SEC=10
    [ -z "$NUKE_DEADLINE_SEC_WAS_SET" ] && NUKE_DEADLINE_SEC=900
    [ -z "$NUKE_DB_TIMEOUT_MS_WAS_SET" ] && export NUKE_DB_TIMEOUT_MS=20000
    [ -z "$NUKE_CLEANUP_DRAIN_SEC_WAS_SET" ] && NUKE_CLEANUP_DRAIN_SEC=120
fi
[ "$NUKE_VMTYPE" = "$DEFAULT_VMTYPE" ] || PER_HR="unknown"

# Memory diagnostics share the responsiveness probes' request budget.
NUKE_DB_TIMEOUT_MS="${NUKE_DB_TIMEOUT_MS:-6000}"
if ! [[ "$NUKE_DB_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [ "$NUKE_DB_TIMEOUT_MS" -lt 1 ]; then
    fail "NUKE_DB_TIMEOUT_MS must be a positive integer (got '$NUKE_DB_TIMEOUT_MS')"
fi
NUKE_MEMORY_TIMEOUT_SEC=$(awk -v timeout_ms="$NUKE_DB_TIMEOUT_MS" 'BEGIN { printf "%.3f", timeout_ms / 1000 }')

# Rough cost preview (face value; excludes retries/quota; spot price floats).
# Lifetime ~= runtime + ~210s overhead (provision/init/pull + 150s spot-confirm).
EST=$(awk -v n="$NUKE_COUNT" -v r="$PER_HR" -v s="$NUKE_RUNTIME_SEC" \
    'BEGIN { if (r=="unknown") print "unknown"; else printf "%.2f", n*r*((s+210)/3600.0) }' 2>/dev/null || echo "unknown")
print_section "Config"
if [ "$NUKE_IS_LOCAL" = true ]; then
    print_info "provider=local  count=$NUKE_COUNT  image=$NUKE_IMAGE  runtime=${NUKE_RUNTIME_SEC}s"
    print_info "COST PREVIEW: 0 USD cloud cost; local nuke creates disposable microVMs only on the CI runner."
else
    print_info "provider=$NUKE_PROVIDER  count=$NUKE_COUNT  vm=$NUKE_VMTYPE  cred=$NUKE_CREDENTIAL  image=$NUKE_IMAGE  runtime=${NUKE_RUNTIME_SEC}s"
    print_info "COST PREVIEW: ~\$${EST} face value ($NUKE_COUNT x \$${PER_HR}/VM-hr x ~$((NUKE_RUNTIME_SEC+210))s) — cloud quota caps real N; retries can multiply churn."
fi
print_info "submit timeout: ${NUKE_SUBMIT_TIMEOUT_SEC}s per job; logs: $NUKE_SUBMIT_LOG_DIR"
print_info "measurement deadline: ${NUKE_DEADLINE_SEC}s; cleanup drain: ${NUKE_CLEANUP_DRAIN_SEC}s; API probe and memory sample timeout: ${NUKE_DB_TIMEOUT_MS}ms"
print_info "memory gates: rss<=${NUKE_MAX_RSS_MB}MB heap<=${NUKE_MAX_HEAP_MB}MB rss-slope<=${NUKE_MAX_RSS_SLOPE_MB_PER_MIN}MB/min heap-slope<=${NUKE_MAX_HEAP_SLOPE_MB_PER_MIN}MB/min"

# --- API + credentials ------------------------------------------------------
print_section "1. Checking for API"
[ -n "$API_URL" ] || fail "API_URL must be set (run via './e2e.sh nuke', or point at an existing API)"
print_info "Using API at: $API_URL"
NUKE_RUN_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

NUKE_DB_HEAVY_ID=""
NUKE_DB_LAST_PROBE=-999
nuke_db_load_manifest "$NUKE_DB_MANIFEST"
print_info "nuke-db manifest=$NUKE_DB_MANIFEST  heavy_status_id=$NUKE_DB_HEAVY_ID"
nuke_db_assert_historical_seed_invariants "pre-submit nuke seed"

# Register real-cloud creds under NUKE_CREDENTIAL (re-key so an overridden name
# still resolves), and tell cli_bucket which credential to use for cleanup. The
# Local harness lane uses API-instance compute and has no credentials.
if [ "$NUKE_IS_LOCAL" = true ]; then
    print_info "local provider selected: no cloud credentials registered"
else
    CREDS_JSON=$(printf '%s' "$RAW_CREDS_JSON" | jq --arg n "$NUKE_CREDENTIAL" 'to_entries | {($n): (.[0].value)}')
    setup_api_credentials "$CREDS_JSON"
    export ANYCLOUD_BUCKET_CREDENTIAL="$NUKE_CREDENTIAL"
fi

OUTPUT_BUCKET="nuke-out-${TEST_RUN}"   # ONE shared output bucket (bucket-sync fan-in)
NUKE_IDS=()
NUKE_WITNESS_IDS=()
NUKE_FAIRNESS_SESSION="${NUKE_FAIRNESS_USER}-${TEST_RUN}"
NUKE_FAIRNESS_FILE="${RESULTS_DIR:-/tmp}/nuke-fairness-samples.jsonl"
NUKE_WITNESS_SUBMITTED_EPOCH=0
: > "$NUKE_FAIRNESS_FILE"

# --- Cleanup (idempotent; tears down on every process exit) -----------------
# Every exit terminates and verifies every submitted ID. The EXIT handler
# preserves an existing failure and converts a clean exit to failure when this
# cleanup cannot be verified.
# The cloud-level ci/cleanup/<provider>.ts post-step is the real safety net.
# Never let cleanup abort under set -e.
cleanup_local_smolvm_resources() {
    yarn -s local-runtime:cleanup >/dev/null 2>&1 || true
}

cleanup() {
    local leaked="" cleanup_ids=() cleanup_rc=0

    # Stop/reap complete submission groups first so an early failure cannot
    # accept new workloads while cleanup terminates same-run resources.
    nuke_stop_submissions || cleanup_rc=1

    # Any unexpected post-start exit should still leave the same diagnostic
    # artifact as the explicit failure paths below. Emit after submissions stop,
    # but before cleanup mutates workload state or stops the memory sampler.
    if [ "$NUKE_CLASSIFICATION_EMITTED" != true ] &&
        [ "$NUKE_CLASSIFICATION_IN_PROGRESS" != true ] &&
        [ -n "${API_URL:-}" ] && [ -n "$NUKE_RUN_START_ISO" ] &&
        type emit_nuke_classification >/dev/null 2>&1; then
        emit_nuke_classification early-abort || true
    fi
    type stop_health_sampler >/dev/null 2>&1 && stop_health_sampler
    type stop_api_memory_sampler >/dev/null 2>&1 && stop_api_memory_sampler
    type evaluate_host_metrics >/dev/null 2>&1 && evaluate_host_metrics

    if [ "$NUKE_USES_BUCKET_SYNC" = true ]; then
        print_section "Cleaning up (all submitted workloads + output bucket)"
    else
        print_section "Cleaning up (all submitted workloads)"
    fi

    for id in "${NUKE_IDS[@]}"; do
        [ -n "$id" ] || continue
        cleanup_ids+=("$id")
    done
    print_info "${#cleanup_ids[@]} workload(s) to terminate (of ${#NUKE_IDS[@]} total)"

    if [ -n "${NUKE_CLEANUP_RECORD_DIR:-}" ]; then
        nuke_capture_caller_inventory normal inventory "${cleanup_ids[@]}" || cleanup_rc=1
    fi
    if ! NUKE_CLEANUP_COHORT=normal nuke_terminate_and_drain \
        "nuke EXIT cleanup" \
        "$NUKE_CLEANUP_DRAIN_SEC" \
        "${cleanup_ids[@]}"; then
        leaked="$leaked ${cleanup_ids[*]}"
    fi

    # The witness cohort is drained on its own, under the same token.
    if [ "${#NUKE_WITNESS_IDS[@]}" -gt 0 ]; then
        print_info "${#NUKE_WITNESS_IDS[@]} witness workload(s) to terminate"
    fi
    if [ -n "${NUKE_CLEANUP_RECORD_DIR:-}" ]; then
        nuke_capture_caller_inventory witness inventory "${NUKE_WITNESS_IDS[@]}" || cleanup_rc=1
    fi
    if ! (
        NUKE_CLEANUP_COHORT=witness \
            nuke_terminate_and_drain \
                "nuke witness cleanup" \
                "$NUKE_CLEANUP_DRAIN_SEC" \
                "${NUKE_WITNESS_IDS[@]}"
    ); then
        leaked="$leaked ${NUKE_WITNESS_IDS[*]}"
        cleanup_rc=1
    fi

    # Delete bucket-sync resources for real-cloud runs. The no-cloud Local
    #    lane has no storage buckets; sweep owned microVMs directly
    #    as a fallback if API termination was interrupted.
    if [ "$NUKE_USES_BUCKET_SYNC" = true ]; then
        "$DELETE_BUCKET_FN" "$OUTPUT_BUCKET" 2>/dev/null || true
        for id in "${cleanup_ids[@]}"; do
            "$DELETE_BUCKET_FN" "$id" 2>/dev/null || true
        done
    elif [ "$NUKE_IS_LOCAL" = true ]; then
        cleanup_local_smolvm_resources
    fi

    # For Azure nuke runs, remove fresh same-run test networking immediately.
    # Generic CI cleanup waits for the 3h orphan age, which is right for normal
    # resources but leaves cancelled nuke runs' detached NSGs/VNets behind.
    if [ "$NUKE_PROVIDER" = "azure" ] && [ "${#NUKE_IDS[@]}" -gt 0 ]; then
        npx tsx ci/cleanup/azure-nuke-run.ts "nuke-${TEST_RUN}-" \
            >/dev/null 2>&1 || true
    fi
    if [ "$NUKE_PROVIDER" = "azure" ] && [ "${#NUKE_WITNESS_IDS[@]}" -gt 0 ]; then
        npx tsx ci/cleanup/azure-nuke-run.ts "nuke-witness-${TEST_RUN}-" \
            >/dev/null 2>&1 || true
    fi

    if [ -n "$leaked" ]; then
        if [ "$NUKE_IS_LOCAL" = true ]; then
            print_warning "LOCAL CLEANUP MAY BE NEEDED for:$leaked"
            print_warning "Check smolvm machines on the runner."
        else
            print_warning "MANUAL CLOUD CLEANUP MAY BE NEEDED for:$leaked"
            print_warning "Check the cloud console and: anycloud bucket list"
        fi
        return 1
    fi
    return "$cleanup_rc"
}
nuke_install_cleanup_traps

api_url_is_loopback() {
    case "$API_URL" in
        http://localhost|https://localhost|http://localhost:*|https://localhost:*|http://localhost/*|https://localhost/*|\
        http://127.0.0.1|https://127.0.0.1|http://127.0.0.1:*|https://127.0.0.1:*|http://127.0.0.1/*|https://127.0.0.1/*|\
        http://\[::1\]|https://\[::1\]|http://\[::1\]:*|https://\[::1\]:*|http://\[::1\]/*|https://\[::1\]/*)
            return 0
            ;;
        *) return 1 ;;
    esac
}

capture_api_log_snapshot() {
    mkdir -p "$(dirname "$NUKE_API_LOG_FILE")"
    : > "$NUKE_API_LOG_FILE"

    # A remote API may coexist with an unrelated local anycloud-api container.
    # Only infer the default container for loopback URLs; a caller can explicitly
    # name a container for any other topology or set the variable empty to opt out.
    if ! api_url_is_loopback && [ "$NUKE_API_CONTAINER_EXPLICIT" != true ]; then
        return 0
    fi
    [ -n "$NUKE_API_CONTAINER" ] || return 0

    if ! command -v docker >/dev/null 2>&1; then
        print_warning "api-log capture skipped: docker is unavailable; diagnostic signals will exclude API logs"
        return 0
    fi
    if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Fqx -- "$NUKE_API_CONTAINER"; then
        print_warning "api-log capture skipped: no container named '$NUKE_API_CONTAINER' (override with NUKE_API_CONTAINER); diagnostic signals will exclude API logs"
        return 0
    fi

    if [ -n "$NUKE_RUN_START_ISO" ]; then
        if ! docker logs --since "$NUKE_RUN_START_ISO" "$NUKE_API_CONTAINER" > "$NUKE_API_LOG_FILE" 2>&1; then
            print_warning "api-log capture failed for '$NUKE_API_CONTAINER'; diagnostic signals will exclude API logs"
            : > "$NUKE_API_LOG_FILE"
        fi
    elif ! docker logs "$NUKE_API_CONTAINER" > "$NUKE_API_LOG_FILE" 2>&1; then
        print_warning "api-log capture failed for '$NUKE_API_CONTAINER'; diagnostic signals will exclude API logs"
        : > "$NUKE_API_LOG_FILE"
    fi
}

classify_nuke_outcomes() {
    local snapshot_kind="${1:-early-abort}"
    mkdir -p "$(dirname "$NUKE_FINAL_LIST_FILE")" "$(dirname "$NUKE_CLASSIFICATION_FILE")"
    # Capture the API's own account before asking an overloaded API for another
    # list response. The list is bounded separately and may fall back to [].
    capture_api_log_snapshot
    nuke_list_json_best_effort > "$NUKE_FINAL_LIST_FILE"

    local summary rc
    set +e
    summary=$(NUKE_LIST_FILE="$NUKE_FINAL_LIST_FILE" \
        NUKE_API_LOG_FILE="$NUKE_API_LOG_FILE" \
        NUKE_MEMORY_REPORT_FILE="$NUKE_MEMORY_REPORT_FILE" \
        NUKE_CLASSIFICATION_FILE="$NUKE_CLASSIFICATION_FILE" \
        NUKE_EXPECTED_COUNT="$NUKE_COUNT" \
        NUKE_WORKLOAD_ID_PREFIX="nuke-${TEST_RUN}-" \
        NUKE_SNAPSHOT_KIND="$snapshot_kind" \
        node "$SCRIPT_DIR/helpers/nuke-classify-outcomes.mjs" 2>&1)
    rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        print_warning "nuke classification failed: $summary"
        return 0
    fi

    while IFS= read -r line; do
        case "$line" in
            warning:\ *) print_warning "${line#warning: }" ;;
            *) [ -n "$line" ] && print_info "$line" ;;
        esac
    done <<< "$summary"
    print_info "classification artifact: $NUKE_CLASSIFICATION_FILE"
}

emit_nuke_classification() {
    local snapshot_kind="${1:-early-abort}"
    [ "$NUKE_CLASSIFICATION_IN_PROGRESS" = true ] && return 0

    NUKE_CLASSIFICATION_IN_PROGRESS=true
    evaluate_api_memory_budget
    evaluate_host_metrics
    classify_nuke_outcomes "$snapshot_kind"
    NUKE_CLASSIFICATION_EMITTED=true
    NUKE_CLASSIFICATION_IN_PROGRESS=false
}

submit_log_path() {
    printf '%s/%s.log' "$NUKE_SUBMIT_LOG_DIR" "$1"
}

submit_rc_path() {
    printf '%s/%s.rc' "$NUKE_SUBMIT_LOG_DIR" "$1"
}

submit_one() {
    local id="$1" index="$2" log_file rc_file rc
    log_file="$(submit_log_path "$id")"
    rc_file="$(submit_rc_path "$id")"
    {
        printf '[%s] submit start id=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id"
        set +e
        if [ "$NUKE_IS_LOCAL" = true ]; then
            # Local is credentialless. Build its CLI environment from an
            # allowlist so ambient or future cloud credentials cannot select a
            # different provider.
            env -i \
                PATH="$PATH" \
                CI=true \
                API_URL="$API_URL" \
                ANYCLOUD_DIR="$ANYCLOUD_DIR" \
                GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
                "$SUBMIT_TIMEOUT_CMD" --foreground --kill-after=30s "$NUKE_SUBMIT_TIMEOUT_SEC" \
                node "$PROJECT_ROOT/dist/cli/index.js" job \
                    --id "$id" \
                    "$NUKE_IMAGE" \
                    -- sh -c "echo nuke-${index}; sleep ${NUKE_RUNTIME_SEC}" \
                    </dev/null
        else
            local -a cloud_flags=()
            local workload
            if [ "$NUKE_USES_SPOT" = true ]; then
                cloud_flags+=(--spot)
            fi
            if [ "$NUKE_USES_BUCKET_SYNC" = true ]; then
                cloud_flags+=(--output-bucket "$OUTPUT_BUCKET")
                workload="echo nuke-${index} > /mnt/output/${index}.txt; sleep ${NUKE_RUNTIME_SEC}"
            else
                workload="echo nuke-${index}; sleep ${NUKE_RUNTIME_SEC}"
            fi
            # An agent shell's session would otherwise give the wall a lane.
            env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_BIN_PATH \
                -u CODEX_THREAD_ID -u CURSOR_TRACE_ID -u AIDER_MODEL \
                API_URL="$API_URL" GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
                "$SUBMIT_TIMEOUT_CMD" --foreground --kill-after=30s "$NUKE_SUBMIT_TIMEOUT_SEC" \
                node "$PROJECT_ROOT/dist/cli/index.js" job \
                    --id "$id" \
                    --credentials "$NUKE_CREDENTIAL" \
                    --vm-type "$NUKE_VMTYPE" \
                    "${cloud_flags[@]}" \
                    "$NUKE_IMAGE" \
                    -- sh -c "$workload" \
                    </dev/null
        fi
        rc=$?
        set -e
        printf '[%s] submit exit id=%s rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "$rc"
    } >"$log_file" 2>&1
    printf '%s\n' "$rc" > "$rc_file"
    return "$rc"
}

# The witness is a second lane: an agent session the wall's sessionless jobs
# don't share, with the wall's credential and the local API's one owner. No
# output bucket — only their time-to-leave-queued is measured.
submit_witness_one() {
    local id="$1" index="$2" log_file rc_file rc
    log_file="$(submit_log_path "$id")"
    rc_file="$(submit_rc_path "$id")"
    {
        printf '[%s] witness submit start id=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id"
        set +e
        if [ "$NUKE_IS_LOCAL" = true ]; then
            env -i \
                PATH="$PATH" \
                CI=true \
                API_URL="$API_URL" \
                ANYCLOUD_DIR="$ANYCLOUD_DIR" \
                GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
                CODEX_THREAD_ID="$NUKE_FAIRNESS_SESSION" \
                "$SUBMIT_TIMEOUT_CMD" --foreground --kill-after=30s "$NUKE_SUBMIT_TIMEOUT_SEC" \
                node "$PROJECT_ROOT/dist/cli/index.js" job \
                    --id "$id" \
                    "$NUKE_IMAGE" \
                    -- sh -c "echo nuke-witness-${index}; sleep ${NUKE_RUNTIME_SEC}" \
                    </dev/null
        else
            # Only the witness's own session decides its lane.
            env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_BIN_PATH \
                -u CURSOR_TRACE_ID -u AIDER_MODEL \
                API_URL="$API_URL" GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
                CODEX_THREAD_ID="$NUKE_FAIRNESS_SESSION" \
                "$SUBMIT_TIMEOUT_CMD" --foreground --kill-after=30s "$NUKE_SUBMIT_TIMEOUT_SEC" \
                node "$PROJECT_ROOT/dist/cli/index.js" job \
                    --id "$id" \
                    --credentials "$NUKE_CREDENTIAL" \
                    --vm-type "$NUKE_VMTYPE" \
                    "$NUKE_IMAGE" \
                    -- sh -c "echo nuke-witness-${index}; sleep ${NUKE_RUNTIME_SEC}" \
                    </dev/null
        fi
        rc=$?
        set -e
        printf '[%s] witness submit exit id=%s rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "$rc"
    } >"$log_file" 2>&1
    printf '%s\n' "$rc" > "$rc_file"
    if [ "$rc" -eq 0 ] && [ "${NUKE_INTERRUPT_AFTER_WITNESS:-false}" = true ] && [ "$index" -eq 1 ]; then
        nuke_hold_admitted_witness "$id"
    fi
    return "$rc"
}

record_witness_sample() {
    local elapsed witness_json
    # Relative to the witness's own submission: the completion loop's clock
    # starts after post-submit visibility checks, so a witness dispatched before
    # the first poll would otherwise be indistinguishable from one never queued.
    elapsed=$(( $(date +%s) - NUKE_WITNESS_SUBMITTED_EPOCH ))
    witness_json=$(API_URL="$API_URL" IS_TEST=true \
        node "$PROJECT_ROOT/dist/cli/index.js" list --json \
            --filter "nuke-witness-${TEST_RUN}-" -n "$NUKE_FAIRNESS_WITNESS_COUNT" \
        2>/dev/null) || return 0
    printf '%s' "$witness_json" \
        | jq -c --argjson t "$elapsed" '{t: $t, workloads: .}' \
        >> "$NUKE_FAIRNESS_FILE" 2>/dev/null || true
}

# Queue fairness: a second lane's jobs, submitted last behind a backlog deeper
# than the dispatch window, must still win a slot. See helpers/nuke-fairness.mjs.
assert_queue_fairness() {
    local witness_csv
    witness_csv=$(IFS=,; printf '%s' "${NUKE_WITNESS_IDS[*]}")
    if ! node "$SCRIPT_DIR/helpers/nuke-fairness.mjs" \
        --samples "$NUKE_FAIRNESS_FILE" \
        --max-dispatch-sec "$NUKE_FAIRNESS_MAX_DISPATCH_SEC" \
        --witness "$witness_csv"; then
        fail "Queue-fairness gate failed: a second lane starved behind the overlay. Samples: $NUKE_FAIRNESS_FILE"
    fi
}

join_first_ids() {
    local limit="${1:-10}" out="" count=0 id
    shift || true
    for id in "$@"; do
        [ -n "$id" ] || continue
        if [ "$count" -gt 0 ]; then out="$out, "; fi
        out="$out$id"
        count=$((count + 1))
        [ "$count" -ge "$limit" ] && break
    done
    printf '%s' "$out"
}

summarize_submit_results() {
    local ok=0 failed=0 timed_out=0 missing=0 id rc_file rc
    local failed_ids=() timed_out_ids=() missing_ids=()

    for id in "${NUKE_IDS[@]}"; do
        rc_file="$(submit_rc_path "$id")"
        if [ ! -s "$rc_file" ]; then
            missing=$((missing + 1))
            missing_ids+=("$id")
            continue
        fi
        rc="$(tr -d '[:space:]' < "$rc_file")"
        case "$rc" in
            0)
                ok=$((ok + 1))
                ;;
            124|137)
                timed_out=$((timed_out + 1))
                timed_out_ids+=("$id")
                ;;
            *)
                failed=$((failed + 1))
                failed_ids+=("$id")
                ;;
        esac
    done

    print_info "submit summary: ok=$ok failed=$failed timed_out=$timed_out missing_rc=$missing logs=$NUKE_SUBMIT_LOG_DIR"
    if [ "$timed_out" -gt 0 ]; then
        emit_nuke_classification early-abort
        fail "Nuke submit timeout for ${timed_out}/${NUKE_COUNT} job(s): $(join_first_ids 10 "${timed_out_ids[@]}"). Inspect $NUKE_SUBMIT_LOG_DIR/<id>.log"
    fi
    if [ "$failed" -gt 0 ]; then
        emit_nuke_classification early-abort
        fail "Nuke submit failed for ${failed}/${NUKE_COUNT} job(s): $(join_first_ids 10 "${failed_ids[@]}"). Inspect $NUKE_SUBMIT_LOG_DIR/<id>.log"
    fi
    if [ "$missing" -gt 0 ]; then
        emit_nuke_classification early-abort
        fail "Nuke submit wrapper exited without rc file for ${missing}/${NUKE_COUNT} job(s): $(join_first_ids 10 "${missing_ids[@]}"). Inspect $NUKE_SUBMIT_LOG_DIR"
    fi
}

assert_post_submit_visibility() {
    [ "$NUKE_POST_SUBMIT_VISIBILITY_SEC" -gt 0 ] || return 0

    local deadline=$(( $(date +%s) + NUKE_POST_SUBMIT_VISIBILITY_SEC ))
    local list_file missing_file missing_count
    list_file="${RESULTS_DIR:-/tmp}/nuke-post-submit-list.json"
    missing_file="${RESULTS_DIR:-/tmp}/nuke-post-submit-missing.txt"

    while :; do
        nuke_list_snapshot "post-submit visibility" "$list_file"
        : > "$missing_file"
        for id in "${NUKE_IDS[@]}"; do
            if ! jq -e --arg id "$id" '.[]? | select(.id == $id)' "$list_file" >/dev/null; then
                printf '%s\n' "$id" >> "$missing_file"
            fi
        done
        missing_count=$(wc -l < "$missing_file" | tr -d '[:space:]')
        [ "${missing_count:-0}" -eq 0 ] && return 0
        [ "$(date +%s)" -ge "$deadline" ] && break
        sleep 5
    done

    emit_nuke_classification early-abort
    fail "Only $((NUKE_COUNT - missing_count))/${NUKE_COUNT} accepted nuke workloads appeared in list within ${NUKE_POST_SUBMIT_VISIBILITY_SEC}s; first missing: $(head -10 "$missing_file" | paste -sd ', ' -)"
}

maybe_responsiveness_probe() {
    local elapsed="$1"
    if [ $(( elapsed - NUKE_DB_LAST_PROBE )) -lt 60 ]; then
        return 0
    fi
    NUKE_DB_LAST_PROBE="$elapsed"
    nuke_db_probe_api_responsiveness "t=${elapsed}s"
}

assert_no_api_runtime_signatures() {
    [ -s "$NUKE_API_LOG_FILE" ] || return 0

    local sig_file="${RESULTS_DIR:-/tmp}/nuke-api-signatures.err"
    if grep -Ei \
        'Uncaught exception|Fatal SQLite|SQLITE_(CORRUPT|IOERR|FULL|CANTOPEN)|heap out of memory|out of memory|Killed process' \
        "$NUKE_API_LOG_FILE" > "$sig_file"; then
        fail "API log contains crash/OOM/fatal SQLite signature: $(head -1 "$sig_file")"
    fi
}

sample_api_memory() {
    local elapsed="$1"
    local sample rc

    set +e
    sample=$(curl -fsS --max-time "$NUKE_MEMORY_TIMEOUT_SEC" "$API_URL/__test/memory" 2>/dev/null)
    rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        printf '{"elapsedSec":%s,"error":"memory endpoint curl failed","curlExit":%s}\n' "$elapsed" "$rc" >> "$NUKE_MEMORY_FILE"
        return "$rc"
    fi

    printf '%s\n' "$sample" | jq -c --argjson elapsedSec "$elapsed" '. + {elapsedSec: $elapsedSec}' >> "$NUKE_MEMORY_FILE"
}

start_api_memory_sampler() {
    mkdir -p "$(dirname "$NUKE_MEMORY_FILE")"
    : > "$NUKE_MEMORY_FILE"
    NUKE_MEMORY_SAMPLER_STARTED=true

    local first rc
    set +e
    first=$(curl -fsS --max-time "$NUKE_MEMORY_TIMEOUT_SEC" "$API_URL/__test/memory" 2>/dev/null)
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
        printf '{"elapsedSec":0,"error":"memory endpoint curl failed","curlExit":%s}\n' "$rc" >> "$NUKE_MEMORY_FILE"
        emit_nuke_classification early-abort
        fail "API memory endpoint is unavailable; run nuke through './e2e.sh nuke' or start the API with IS_TEST=true"
    fi
    if ! printf '%s\n' "$first" | jq -e 'has("rssBytes") and has("heapUsedBytes") and has("heapTotalBytes")' >/dev/null; then
        printf '{"elapsedSec":0,"error":"memory endpoint returned an unexpected payload"}\n' >> "$NUKE_MEMORY_FILE"
        emit_nuke_classification early-abort
        fail "API memory endpoint returned an unexpected payload"
    fi

    API_MEMORY_START_TS=$(date +%s)
    printf '%s\n' "$first" | jq -c '. + {elapsedSec: 0}' >> "$NUKE_MEMORY_FILE"

    (
        set +e
        while :; do
            sleep "$NUKE_MEMORY_SAMPLE_SEC"
            elapsed=$(( $(date +%s) - API_MEMORY_START_TS ))
            sample_api_memory "$elapsed" >/dev/null 2>&1 || true
        done
    ) &
    API_MEMORY_SAMPLER_PID=$!
    print_info "memory samples: $NUKE_MEMORY_FILE"
}

stop_api_memory_sampler() {
    if [ -n "${API_MEMORY_SAMPLER_PID:-}" ]; then
        kill "$API_MEMORY_SAMPLER_PID" 2>/dev/null || true
        wait "$API_MEMORY_SAMPLER_PID" 2>/dev/null || true
        API_MEMORY_SAMPLER_PID=""
    fi
}

evaluate_api_memory_budget() {
    [ "$NUKE_MEMORY_BUDGET_EVALUATED" = true ] && return 0
    mkdir -p "$(dirname "$NUKE_MEMORY_REPORT_FILE")"
    if [ "$NUKE_MEMORY_SAMPLER_STARTED" != true ]; then
        printf '{"ok":false,"failures":["memory sampler not started"],"warnings":[],"stats":null}\n' > "$NUKE_MEMORY_REPORT_FILE"
        NUKE_MEMORY_BUDGET_EVALUATED=true
        NUKE_MEMORY_BUDGET_RC=1
        NUKE_MEMORY_BUDGET_SUMMARY="Memory sampler did not start; no memory coverage"
        return 0
    fi

    stop_api_memory_sampler
    if [ -n "${API_MEMORY_START_TS:-}" ]; then
        sample_api_memory "$(( $(date +%s) - API_MEMORY_START_TS ))" >/dev/null 2>&1 || true
    fi

    # Leave a valid fallback report if the analyzer itself fails before writing
    # its structured result, so outcome classification remains usable.
    printf '{"ok":false,"failures":["memory budget analyzer failed"],"warnings":[],"stats":null}\n' > "$NUKE_MEMORY_REPORT_FILE"
    set +e
    NUKE_MEMORY_BUDGET_SUMMARY=$(NUKE_MEMORY_FILE="$NUKE_MEMORY_FILE" \
        NUKE_MEMORY_REPORT_FILE="$NUKE_MEMORY_REPORT_FILE" \
        NUKE_MAX_RSS_MB="$NUKE_MAX_RSS_MB" \
        NUKE_MAX_HEAP_MB="$NUKE_MAX_HEAP_MB" \
        NUKE_MAX_RSS_SLOPE_MB_PER_MIN="$NUKE_MAX_RSS_SLOPE_MB_PER_MIN" \
        NUKE_MAX_HEAP_SLOPE_MB_PER_MIN="$NUKE_MAX_HEAP_SLOPE_MB_PER_MIN" \
        NUKE_MEMORY_WARMUP_SEC="$NUKE_MEMORY_WARMUP_SEC" \
        NUKE_MEMORY_MAX_TRANSIENT_SAMPLE_ERRORS="$NUKE_MEMORY_MAX_TRANSIENT_SAMPLE_ERRORS" \
        NUKE_MEMORY_MAX_CONSECUTIVE_SAMPLE_ERRORS="$NUKE_MEMORY_MAX_CONSECUTIVE_SAMPLE_ERRORS" \
        NUKE_MEMORY_MAX_SAMPLE_ERROR_RATE="$NUKE_MEMORY_MAX_SAMPLE_ERROR_RATE" \
        node "$SCRIPT_DIR/helpers/nuke-memory-budget.mjs" 2>&1
    )
    NUKE_MEMORY_BUDGET_RC=$?
    set -e
    NUKE_MEMORY_BUDGET_EVALUATED=true
    return 0
}

assert_api_memory_budget() {
    evaluate_api_memory_budget

    if [ "$NUKE_MEMORY_BUDGET_RC" -ne 0 ]; then
        echo "$NUKE_MEMORY_BUDGET_SUMMARY" >&2
        fail "API memory budget failed; samples: $NUKE_MEMORY_FILE"
    fi
    while IFS= read -r line; do
        case "$line" in
            warning:\ *) print_warning "${line#warning: }" ;;
            *) print_info "$line" ;;
        esac
    done <<< "$NUKE_MEMORY_BUDGET_SUMMARY"
}

sample_host() {
    local elapsed="$1"
    NUKE_HOST_ELAPSED_SEC="$elapsed" \
        NUKE_PROVIDER="$NUKE_PROVIDER" \
        NUKE_API_CONTAINER="$NUKE_API_CONTAINER" \
        NUKE_SMOLVM_CAPTURE_DIR="$(dirname "$NUKE_HOST_FILE")/smolvm-stopped" \
        node "$SCRIPT_DIR/helpers/nuke-host-metrics.mjs" sample \
        >> "$NUKE_HOST_FILE" 2>/dev/null
}

start_host_sampler() {
    mkdir -p "$(dirname "$NUKE_HOST_FILE")"
    : > "$NUKE_HOST_FILE"
    NUKE_HOST_SAMPLER_STARTED=true
    HOST_START_TS=$(date +%s)
    sample_host 0 || true

    (
        set +e
        while :; do
            sleep "$NUKE_HOST_SAMPLE_SEC"
            elapsed=$(( $(date +%s) - HOST_START_TS ))
            sample_host "$elapsed" || true
        done
    ) &
    HOST_SAMPLER_PID=$!
    print_info "runner host/API-container samples: $NUKE_HOST_FILE"
}

stop_host_sampler() {
    if [ -n "${HOST_SAMPLER_PID:-}" ]; then
        kill "$HOST_SAMPLER_PID" 2>/dev/null || true
        wait "$HOST_SAMPLER_PID" 2>/dev/null || true
        HOST_SAMPLER_PID=""
    fi
}

wait_for_host_quiescence() {
    [ "$NUKE_HOST_SAMPLER_STARTED" = true ] || return 0
    [ -n "${HOST_START_TS:-}" ] || return 0

    local deadline now elapsed
    deadline=$(( $(date +%s) + NUKE_HOST_QUIESCENCE_SEC ))
    while :; do
        elapsed=$(( $(date +%s) - HOST_START_TS ))
        sample_host "$elapsed" || true
        if NUKE_HOST_FILE="$NUKE_HOST_FILE" \
            node "$SCRIPT_DIR/helpers/nuke-host-metrics.mjs" quiescent \
            >/dev/null 2>&1; then
            return 0
        fi

        now=$(date +%s)
        [ "$now" -ge "$deadline" ] && return 0
        sleep 1
    done
}

evaluate_host_metrics() {
    [ "$NUKE_HOST_METRICS_EVALUATED" = true ] && return 0
    mkdir -p "$(dirname "$NUKE_HOST_REPORT_FILE")"

    stop_host_sampler
    wait_for_host_quiescence

    printf '{"ok":false,"failures":["runner host metrics analyzer failed"],"warnings":[],"stats":null}\n' > "$NUKE_HOST_REPORT_FILE"
    set +e
    NUKE_HOST_METRICS_SUMMARY=$(NUKE_HOST_FILE="$NUKE_HOST_FILE" \
        NUKE_HOST_REPORT_FILE="$NUKE_HOST_REPORT_FILE" \
        node "$SCRIPT_DIR/helpers/nuke-host-metrics.mjs" report 2>&1)
    NUKE_HOST_METRICS_RC=$?
    set -e
    NUKE_HOST_METRICS_EVALUATED=true
    return 0
}

assert_host_metrics() {
    evaluate_host_metrics

    if [ "$NUKE_HOST_METRICS_RC" -ne 0 ]; then
        echo "$NUKE_HOST_METRICS_SUMMARY" >&2
        fail "Runner host metrics failed; samples: $NUKE_HOST_FILE"
    fi
    while IFS= read -r line; do
        case "$line" in
            warning:\ *) print_warning "${line#warning: }" ;;
            *) [ -n "$line" ] && print_info "$line" ;;
        esac
    done <<< "$NUKE_HOST_METRICS_SUMMARY"
}

start_api_memory_sampler
start_host_sampler
nuke_db_probe_api_responsiveness "pre-submit"

start_health_sampler() {
    NUKE_PROVIDER="$NUKE_PROVIDER" \
        node "$SCRIPT_DIR/helpers/nuke-host-metrics.mjs" health \
        > "$RESULTS_DIR/nuke-health.log" 2>&1 &
    HEALTH_SAMPLER_PID=$!
    local deadline=$(( $(date +%s) + 40 ))
    until [ -f "$RESULTS_DIR/nuke-health-ready" ]; do
        if ! kill -0 "$HEALTH_SAMPLER_PID" 2>/dev/null || [ "$(date +%s)" -ge "$deadline" ]; then
            cat "$RESULTS_DIR/nuke-health.log"
            fail "Independent HTTP/SSH pressure sampler did not start"
        fi
        sleep 0.1
    done
}

stop_health_sampler() {
    [ -n "$HEALTH_SAMPLER_PID" ] || return 0
    kill "$HEALTH_SAMPLER_PID" 2>/dev/null || true
    NUKE_HEALTH_RC=0
    wait "$HEALTH_SAMPLER_PID" || NUKE_HEALTH_RC=$?
    HEALTH_SAMPLER_PID=""
}

assert_responsiveness() {
    stop_health_sampler
    cat "$RESULTS_DIR/nuke-health.log"
    if [ "$NUKE_HEALTH_RC" -ne 0 ] || ! jq -e '.ok == true' "$RESULTS_DIR/nuke-health-report.json" >/dev/null; then
        fail "Nuke HTTP/SSH pressure gate failed; see $RESULTS_DIR/nuke-health-report.json"
    fi
}

start_health_sampler

# --- Fire N submits in a bounded burst --------------------------------------
# Each cli_run is a full `node ... submit` process (~100 MB RSS). Cap in-flight
# submits to SUBMIT_PARALLELISM so we still create a burst (the API caps
# provisioning at 50 server-side anyway) WITHOUT fork-bombing the test host —
# launching all N at once at NUKE_COUNT=1000 would OOM the runner before the API
# is meaningfully stressed, confounding the signal.
if [ "$NUKE_IS_LOCAL" = true ]; then
    NUKE_SUBMIT_SHAPE="local smolvm VM hosts, no cloud resources"
else
    NUKE_SUBMIT_SHAPE="$NUKE_VMTYPE"
    [ "$NUKE_USES_SPOT" = true ] && NUKE_SUBMIT_SHAPE="$NUKE_SUBMIT_SHAPE, spot"
    [ "$NUKE_USES_BUCKET_SYNC" = true ] && NUKE_SUBMIT_SHAPE="$NUKE_SUBMIT_SHAPE, bucket-sync"
fi
print_section "2. Firing $NUKE_COUNT submits ($NUKE_SUBMIT_SHAPE; <=${SUBMIT_PARALLELISM} in flight)"
mkdir -p "$NUKE_SUBMIT_LOG_DIR"
inflight=0
for i in $(seq 1 "$NUKE_COUNT"); do
    id="nuke-${TEST_RUN}-${i}"
    NUKE_IDS+=("$id")   # track BEFORE backgrounding so Ctrl-C still cleans up
    nuke_launch_submission submit_one "$id" "$i"
    inflight=$((inflight + 1))
    if [ "$inflight" -ge "$SUBMIT_PARALLELISM" ]; then
        wait -n 2>/dev/null || true   # reap one finished submit before launching the next
        inflight=$((inflight - 1))
    fi
done
print_success "All $NUKE_COUNT submit calls launched; draining"
for pid in "${SUBMIT_PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
done
SUBMIT_PIDS=()
summarize_submit_results
assert_post_submit_visibility

print_section "2b. Submitting $NUKE_FAIRNESS_WITNESS_COUNT witness job(s) from a second lane"
for i in $(seq 1 "$NUKE_FAIRNESS_WITNESS_COUNT"); do
    # Outside the wall's "nuke-${TEST_RUN}-" prefix: every caller now lists both.
    witness_id="nuke-witness-${TEST_RUN}-${i}"
    NUKE_WITNESS_IDS+=("$witness_id")   # track BEFORE submitting so cleanup sees it
    nuke_launch_submission submit_witness_one "$witness_id" "$i"
    if [ "$NUKE_INTERRUPT_AFTER_WITNESS" = true ] && [ "$i" -eq 1 ]; then
        nuke_interrupt_after_witness "$witness_id" "$NUKE_SUBMIT_PID"
        fail "Nuke interruption control did not produce its required TERM exit"
    fi
    if ! wait "$NUKE_SUBMIT_PID"; then
        fail "Witness submit failed for $witness_id. Inspect $NUKE_SUBMIT_LOG_DIR/${witness_id}.log"
    fi
    SUBMIT_PIDS=()
done
NUKE_WITNESS_SUBMITTED_EPOCH=$(date +%s)
print_success "Witness cohort submitted behind $NUKE_COUNT queued jobs"
# Sample at once: the first observation must be close to submission or the
# measurement floor is however long the visibility checks took.
record_witness_sample

# --- Measure full completion ------------------------------------------------
# Poll the LIST endpoint (one call/cycle) classifying each id into completed /
# terminal-failure / still-active until all are terminal or the deadline passes.
# NOTE: on real-cloud spot, a clean exit is marked `completed` only after
# SPOT_EXIT_CONFIRM_MS (~150s), so per-job time-to-completed has a ~150s floor.
print_section "3. Measuring completion (overall deadline ${NUKE_DEADLINE_SEC}s)"
COMPLETED_TIMES=""
COMPLETED=0; FAILED=0; INVALID=0
INVALID_IDS=()
# Ceiling of N*pass% so small smoke runs still demand a real completion — a floor
# would let NUKE_COUNT=1 at 80% require 0, passing the gate with zero completions.
REQUIRED=$(( (NUKE_COUNT * NUKE_PASS_PCT + 99) / 100 ))
START_TS=$(date +%s)

while [ "${#FINAL_STATE[@]}" -lt "$NUKE_COUNT" ]; do
    NOW=$(( $(date +%s) - START_TS ))
    [ "$NOW" -ge "$NUKE_DEADLINE_SEC" ] && break

    nuke_list_snapshot "completion measurement at t=${NOW}s" "$NUKE_POLL_LIST_FILE"
    if ! jq -r '.[] | [.id, .state] | @tsv' \
        "$NUKE_POLL_LIST_FILE" > "$NUKE_POLL_ROWS_FILE"; then
        fail "completion measurement at t=${NOW}s: nuke list entries were malformed"
    fi
    while IFS=$'\t' read -r lid lstate; do
        [ -n "$lid" ] || continue
        [ -n "${FINAL_STATE[$lid]:-}" ] && continue
        case "$lstate" in
            completed)
                FINAL_STATE["$lid"]="completed"
                COMPLETED=$((COMPLETED + 1))
                COMPLETED_TIMES="$COMPLETED_TIMES $NOW"
                ;;
            errored|failed)
                FINAL_STATE["$lid"]="$lstate"
                FAILED=$((FAILED + 1))
                ;;
            invalid)
                FINAL_STATE["$lid"]="$lstate"
                INVALID=$((INVALID + 1))
                INVALID_IDS+=("$lid")
                ;;
        esac
    done < "$NUKE_POLL_ROWS_FILE"

    record_witness_sample
    maybe_responsiveness_probe "$NOW"
    REMAINING_POSSIBLE=$(( NUKE_COUNT - ${#FINAL_STATE[@]} ))
    MAX_POSSIBLE_COMPLETED=$(( COMPLETED + REMAINING_POSSIBLE ))
    print_info "t=${NOW}s  completed=${COMPLETED}  failed=${FAILED}  invalid=${INVALID}  terminal=${#FINAL_STATE[@]}/${NUKE_COUNT}  max_possible=${MAX_POSSIBLE_COMPLETED}"
    if [ "$INVALID" -gt 0 ]; then
        emit_nuke_classification early-abort
        fail "Nuke produced ${INVALID} invalid workload(s), which indicates bad fixed test input/catalog/credential semantics or a provider failure misclassified as terminal: $(join_first_ids 10 "${INVALID_IDS[@]}"). Inspect submit logs in $NUKE_SUBMIT_LOG_DIR and API logs."
    fi
    if [ "$MAX_POSSIBLE_COMPLETED" -lt "$REQUIRED" ]; then
        emit_nuke_classification early-abort
        fail "Pass bar impossible: completed=${COMPLETED}, failed=${FAILED}, invalid=${INVALID}, terminal=${#FINAL_STATE[@]}/${NUKE_COUNT}, max_possible_completed=${MAX_POSSIBLE_COMPLETED}, required=${REQUIRED}. Classification: $NUKE_CLASSIFICATION_FILE"
    fi
    [ "${#FINAL_STATE[@]}" -lt "$NUKE_COUNT" ] && sleep 15
done

ACTIVE=$(( NUKE_COUNT - ${#FINAL_STATE[@]} ))
if [ "$ACTIVE" -gt 0 ]; then
    emit_nuke_classification deadline
else
    emit_nuke_classification complete
fi
assert_no_api_runtime_signatures
assert_responsiveness
assert_api_memory_budget
assert_host_metrics
assert_queue_fairness

# --- Report -----------------------------------------------------------------
print_section "4. Result"
print_info "completed: $COMPLETED / $NUKE_COUNT  (need >= ${REQUIRED}, ${NUKE_PASS_PCT}%)"
print_info "failed (errored/failed): $FAILED"
print_info "invalid: $INVALID"
print_info "still-active at deadline: $ACTIVE"
print_info "classification: $NUKE_CLASSIFICATION_FILE"
if [ "$COMPLETED" -gt 0 ]; then
    # min / median / max time-to-completed (seconds), reusing the spot-confirm-inclusive timings.
    STATS=$(printf '%s\n' $COMPLETED_TIMES | sort -n | awk '
        { v[NR]=$1 }
        END {
            n=NR; mid=int((n+1)/2);
            med = (n%2) ? v[mid] : (v[mid]+v[mid+1])/2;
            printf "min=%ss median=%ss max=%ss", v[1], med, v[n]
        }')
    print_info "time-to-completed: $STATS"
fi

# Hard gate: at least NUKE_PASS_PCT% of jobs must complete the full lifecycle.
# This assumes an account with quota for ~N concurrent small spot VMs; below the
# bar the API/cloud couldn't carry the load. Quota/capacity exhaustion is a known
# failure mode for this real-cloud gate, so inspect the API log for quota errors
# alongside SQLITE_BUSY / HTTP-400 shared-identity contention / retry-storm.
if [ "$COMPLETED" -lt "$REQUIRED" ]; then
    fail "Pass bar not met: ${COMPLETED}/${NUKE_COUNT} completed, need >= ${REQUIRED} (${NUKE_PASS_PCT}%). ${FAILED} failed, ${INVALID} invalid, ${ACTIVE} still-active at deadline. Classification: $NUKE_CLASSIFICATION_FILE"
fi

print_info "Pass bar met: ${COMPLETED}/${NUKE_COUNT} completed (>= ${NUKE_PASS_PCT}%)."

exit 0
