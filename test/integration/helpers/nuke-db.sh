#!/bin/bash

# Shared helpers for tests that run against a seeded nuke-db fixture.
# Assumes helpers/common.sh has already been sourced.

nuke_db_load_manifest() {
    local manifest="${1:-${NUKE_DB_MANIFEST:-}}"

    [ -n "$manifest" ] || fail "NUKE_DB_MANIFEST must be set; run through e2e.sh or pass a seed manifest"
    [ -f "$manifest" ] || fail "NUKE_DB_MANIFEST does not exist: $manifest"

    NUKE_DB_HEAVY_ID="$(jq -r '.heavyStatusWorkloadIds[0] // empty' "$manifest")"
    [ -n "$NUKE_DB_HEAVY_ID" ] || fail "seed nuke-db manifest has no heavyStatusWorkloadIds"

    # Representative seeded sessions for the --session filter probes: one with a
    # human-readable label, and one unlabeled long-id session (rendered as
    # agent:<6char> in the SESSION column).
    local labeled hashed
    labeled="$(jq -c '[.sessions[] | select(.sessionLabel != null)][0] // empty' "$manifest")"
    hashed="$(jq -c '[.sessions[] | select(.sessionLabel == null and .agent != null and ((.session // "") | length) > 12)][0] // empty' "$manifest")"
    [ -n "$labeled" ] || fail "seed nuke-db manifest has no labeled session"
    [ -n "$hashed" ] || fail "seed nuke-db manifest has no unlabeled long-id session"
    NUKE_DB_LABELED_LABEL="$(jq -r '.sessionLabel' <<<"$labeled")"
    NUKE_DB_LABELED_SESSION="$(jq -r '.session' <<<"$labeled")"
    NUKE_DB_LABELED_COUNT="$(jq -r '.workloadCount' <<<"$labeled")"
    NUKE_DB_HASH_SESSION="$(jq -r '.session' <<<"$hashed")"
    NUKE_DB_HASH_DISPLAY="$(jq -r '.displayForm' <<<"$hashed")"
    NUKE_DB_HASH_COUNT="$(jq -r '.workloadCount' <<<"$hashed")"

    export NUKE_DB_MANIFEST="$manifest"
    export NUKE_DB_HEAVY_ID
    export NUKE_DB_LABELED_LABEL NUKE_DB_LABELED_SESSION NUKE_DB_LABELED_COUNT
    export NUKE_DB_HASH_SESSION NUKE_DB_HASH_DISPLAY NUKE_DB_HASH_COUNT
}

nuke_db_run_with_timeout() {
    local timeout_ms="$1"
    shift
    node -e '
      const timeoutMs = Number(process.argv[1]);
      const command = process.argv[2];
      const args = process.argv.slice(3);
      const child = require("child_process").spawn(command, args, {
        stdio: "inherit",
        env: process.env,
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      }, timeoutMs);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (signal) {
          console.error(`timed out after ${timeoutMs}ms`);
          process.exit(124);
        }
        process.exit(code ?? 1);
      });
    ' "$timeout_ms" "$@"
}

nuke_db_probe() {
    local label="$1"
    shift
    local timeout_ms="${NUKE_DB_TIMEOUT_MS:-6000}"
    local probe_dir="${NUKE_DB_PROBE_DIR:-${RESULTS_DIR:-${TEMP_DIR:-/tmp}}}"
    local safe_label start_ms end_ms elapsed_ms err_file

    mkdir -p "$probe_dir"
    safe_label="$(printf '%s' "$label" | tr -cs 'A-Za-z0-9_.-' '-')"
    err_file="$probe_dir/${safe_label}.err"

    start_ms="$(node -e "process.stdout.write(String(Date.now()))")"
    if ! nuke_db_run_with_timeout "$timeout_ms" "$@" >/dev/null 2>"$err_file"; then
        if [ -s "$err_file" ]; then
            print_error "$label stderr:"
            tail -40 "$err_file" >&2
        fi
        fail "$label failed: $(tail -1 "$err_file" 2>/dev/null)"
    fi

    end_ms="$(node -e "process.stdout.write(String(Date.now()))")"
    elapsed_ms=$((end_ms - start_ms))
    print_info "$label ${elapsed_ms}ms"

    if [ "${NUKE_DB_PROBE_PRINT_STDERR_ON_SUCCESS:-false}" = true ] && [ -s "$err_file" ]; then
        tail -20 "$err_file" | sed "s/^/${NUKE_DB_PROBE_STDERR_PREFIX:-}/"
    fi

    if [ "$elapsed_ms" -gt "$timeout_ms" ]; then
        if [ -s "$err_file" ]; then
            print_error "$label stderr:"
            tail -40 "$err_file" >&2
        fi
        fail "$label exceeded ${timeout_ms}ms"
    fi
}

nuke_db_probe_api_responsiveness() {
    local label="${1:-probe}"

    [ -n "${API_URL:-}" ] || fail "API_URL must be set before probing seeded DB responsiveness"
    [ -n "${NUKE_DB_HEAVY_ID:-}" ] || fail "NUKE_DB_HEAVY_ID must be set; call nuke_db_load_manifest first"

    print_info "responsiveness probe ($label): health + unfiltered list + heavy status"
    nuke_db_probe "health ($label)" curl -fsS "$API_URL/health"
    nuke_db_probe "unfiltered list ($label)" env API_URL="$API_URL" IS_TEST=true GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        node "$PROJECT_ROOT/dist/cli/index.js" list --json
    nuke_db_probe "heavy status ($label)" env API_URL="$API_URL" IS_TEST=true GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        node "$PROJECT_ROOT/dist/cli/index.js" status "$NUKE_DB_HEAVY_ID" --json
}

# Run `anycloud list --all --session <form> --json` through the real CLI + API
# and assert the returned row count == expected, while staying within the probe
# timeout (the --session predicate is a non-sargable scan, so this also guards
# its responsiveness at scale). Exercises CLI flag -> workload list -> store SQL.
nuke_db_assert_session_count() {
    local label="$1" form="$2" expected="$3"
    local out actual start_ms end_ms elapsed_ms
    local timeout_ms="${NUKE_DB_TIMEOUT_MS:-6000}"
    # The CLI clamps to MAX_LIST_LIMIT (src/shared/workload-list.ts); request
    # the max and cap the expectation so a larger NUKE_DB_WORKLOADS can't
    # false-fail (the seed weights keep per-session subsets under this at the
    # default size, so the counts stay exact there).
    local max_limit=1000
    if [ "$expected" -gt "$max_limit" ]; then expected="$max_limit"; fi

    [ -n "${API_URL:-}" ] || fail "API_URL must be set before session-filter probes"

    start_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
    if ! out="$(nuke_db_run_with_timeout "$timeout_ms" \
        env API_URL="$API_URL" IS_TEST=true GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token-for-test}" \
        node "$PROJECT_ROOT/dist/cli/index.js" list --limit "$max_limit" --session "$form" --json)"; then
        fail "$label: 'list --limit $max_limit --session $form --json' failed"
    fi
    end_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
    elapsed_ms=$((end_ms - start_ms))

    actual="$(printf '%s' "$out" | jq 'length')"
    [ "$actual" = "$expected" ] ||
        fail "$label: --session '$form' returned $actual rows, expected $expected"
    print_info "$label '$form' -> $actual rows (${elapsed_ms}ms)"
    [ "$elapsed_ms" -le "$timeout_ms" ] || fail "$label exceeded ${timeout_ms}ms"
}

nuke_db_assert_historical_seed_invariants() {
    local label="${1:-historical seed}"
    local db_path="${SQLITE_PATH:-}"

    if [ -z "$db_path" ] && [ -n "${ANYCLOUD_DIR:-}" ]; then
        db_path="$ANYCLOUD_DIR/api.db"
    fi
    if [ -z "$db_path" ]; then
        fail "$label invariant check requires SQLITE_PATH or ANYCLOUD_DIR"
    fi
    [ -f "$db_path" ] || fail "$label invariant check DB does not exist: $db_path"

    SQLITE_PATH="$db_path" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';

const db = new Database(process.env.SQLITE_PATH, { readonly: true });
const activeStates = [
  'queued',
  'provisioning',
  'initializing',
  'downloading',
  'syncing',
  'starting',
  'running',
  'retrying',
  'recovering',
];
const deployingStates = [
  'provisioning',
  'initializing',
  'downloading',
  'syncing',
  'starting',
];
const activePlaceholders = activeStates.map(() => '?').join(', ');
const deployingPlaceholders = deployingStates.map(() => '?').join(', ');
const activeSeed = db.prepare(
  `SELECT COUNT(*) AS count
   FROM workloads
   WHERE id LIKE 'nuke-db-%'
     AND state IN (${activePlaceholders})`,
).get(...activeStates);
const liveSeedVms = db.prepare(
  `SELECT COUNT(*) AS count
   FROM vms
   WHERE workload_id IN (
     SELECT id FROM workloads WHERE id LIKE 'nuke-db-%'
   )
     AND ended_at IS NULL`,
).get();
const deploying = db.prepare(
  `SELECT COUNT(*) AS count
   FROM workloads
   WHERE state IN (${deployingPlaceholders})`,
).get(...deployingStates).count;
db.close();
const failures = [];
if ((activeSeed?.count ?? 0) !== 0) {
  failures.push(`active seeded workloads=${activeSeed.count}`);
}
if ((liveSeedVms?.count ?? 0) !== 0) {
  failures.push(`live seeded VM rows=${liveSeedVms.count}`);
}
if (deploying !== 0) {
  failures.push(`countDeploying=${deploying}`);
}
if (failures.length > 0) {
  console.error(failures.join('; '));
  process.exit(1);
}
console.log(`historical seed invariant ok: active_seed=0 live_seed_vms=0 countDeploying=0`);
NODE
}

# A workload can become terminal before asynchronous provider cleanup
# finishes. Require every selected workload to have no VM row still marked
# live, using the local nuke DB when available and the API's read-only
# provisioning ledger otherwise.
#
# Usage:
#   nuke_assert_workloads_vms_ended <label> <deadline-epoch-seconds> <id>...
nuke_assert_workloads_vms_ended() {
    if [ "$#" -lt 2 ]; then
        fail "nuke_assert_workloads_vms_ended requires a label and absolute deadline"
        return 1
    fi

    local label="$1" deadline_epoch="$2"
    shift 2

    if ! [[ "$deadline_epoch" =~ ^[0-9]+$ ]]; then
        fail "$label VM invariant deadline must be a non-negative integer"
        return 1
    fi
    if [ "$#" -eq 0 ]; then
        print_info "$label VM invariant: no workloads"
        return 0
    fi

    local db_path="${SQLITE_PATH:-}" workload_ids_json
    if [ -z "$db_path" ] && [ -n "${ANYCLOUD_DIR:-}" ]; then
        db_path="$ANYCLOUD_DIR/api.db"
    fi
    if [ -z "$db_path" ]; then
        if ! type wait_for_workloads_no_live_vms_until >/dev/null 2>&1; then
            fail "$label VM invariant cannot use API fallback: wait helper is unavailable"
            return 1
        fi
        print_info "$label VM invariant: checking API provisioning ledger"
        if ! wait_for_workloads_no_live_vms_until "$deadline_epoch" "$@"; then
            fail "$label VM invariant failed"
            return 1
        fi
        print_info "$label VM invariant ok: workloads=$# live_vm_rows=0 source=api-db"
        return 0
    fi
    if [ ! -f "$db_path" ]; then
        fail "$label VM invariant DB does not exist: $db_path"
        return 1
    fi

    workload_ids_json="$(
        printf '%s\n' "$@" |
            jq -Rsc 'split("\n") | map(select(length > 0)) | unique'
    )"

    SQLITE_PATH="$db_path" \
        NUKE_VM_WORKLOAD_IDS="$workload_ids_json" \
        NUKE_VM_DEADLINE_EPOCH="$deadline_epoch" \
        NUKE_VM_LABEL="$label" \
        node --input-type=module <<'NODE'
import Database from 'better-sqlite3';

const label = process.env.NUKE_VM_LABEL ?? 'nuke overlay';
const deadlineEpoch = Number(process.env.NUKE_VM_DEADLINE_EPOCH);
const workloadIds = JSON.parse(process.env.NUKE_VM_WORKLOAD_IDS ?? '[]');
if (
  !Number.isInteger(deadlineEpoch) ||
  deadlineEpoch < 0 ||
  !Array.isArray(workloadIds) ||
  workloadIds.some((id) => typeof id !== 'string' || id.length === 0)
) {
  throw new Error(`${label} VM invariant received invalid input`);
}

const db = new Database(process.env.SQLITE_PATH, { readonly: true });
const listLiveVms = db.prepare(
  `SELECT workload_id, cloud_id
   FROM vms
   WHERE workload_id = ?
     AND ended_at IS NULL
   ORDER BY created_at`,
);
const readLiveVms = () =>
  workloadIds.flatMap((workloadId) => listLiveVms.all(workloadId));

const deadline = deadlineEpoch * 1000;
let liveVms = readLiveVms();
while (liveVms.length > 0 && Date.now() < deadline) {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(1000, deadline - Date.now())),
  );
  liveVms = readLiveVms();
}
db.close();

if (liveVms.length > 0) {
  const examples = liveVms
    .slice(0, 10)
    .map((vm) => `${vm.workload_id}:${vm.cloud_id}`)
    .join(', ');
  console.error(
    `${label} VM invariant failed: ${liveVms.length} live VM row(s) remain (${examples})`,
  );
  process.exit(1);
}

console.log(
  `${label} VM invariant ok: workloads=${workloadIds.length} live_vm_rows=0 source=db`,
);
NODE
}
