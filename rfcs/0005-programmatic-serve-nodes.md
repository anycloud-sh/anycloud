# RFC 0005: Programmatic Serve Nodes

> Status: Rejected
> Date: 2026-06-18
> Author: Luis
> Updated: 2026-08-16 to record the mixed implementation outcome.

> Disposition: The `Client.serve(image, command=...)` node lifecycle shipped,
> but the proposed Python code-sync wrapper was later removed. Its design below
> is retained only as historical context and is not a supported interface.

Builds on [RFC 0003](./0003-serve-revival.md). Assumes the public-use security
posture in [RFC 0004](./0004-serve-hardening.md).

## Summary

Make `anycloud serve` a programmable BYOC GPU node lifecycle API.

RFC 0003 restores the substrate: one long-running VM, one stable HTTPS URL,
`PORT=8088`, Docker `unless-stopped`, and SDK/CLI creation. This RFC defines the
next customer-facing milestone: use that primitive to replace SkyPilot-style
node management for teams that already own routing, capacity reservation,
LiveKit/Daily dispatch, and session state.

The target workflow is not "one anycloud service with many replicas behind a
router." It is "many independent serve deployments, each acting as a GPU node
registered into the customer's own control plane."

## Context / problem

The serving customer's shape is already a working serving control plane:

- a database-backed reservation layer chooses candidate nodes and atomically
  reserves capacity;
- the app creates LiveKit rooms and dispatches agent sessions to a selected
  node URL;
- node daemons report health/capacity and expose internal APIs such as
  `/internal/health` and `/internal/sessions`;
- SkyPilot is used for node lifecycle: launch, status, exec, and down.

That means anycloud does not need to own request routing, affinity, LiveKit
dispatch, or autoscaling policy for this use case. The useful product is a
better programmable node launcher with stable URLs and lifecycle controls.

## Proposal

### Serve node contract

One `serve` deployment is one long-running node.

Required behavior:

- `Client.serve(...)` creates the node;
- `deployment_id` can be caller-supplied, including namespace-prefixed ids such
  as `model-a-001`;
- `server.url` returns `https://<deployment-id>.anycloud.sh`;
- workload env includes `DEPLOYMENT_ID` and `PORT=8088`;
- the container can self-register with the customer's control plane using those
  env vars;
- status, logs, exec, and terminate use the `Server` handle, which shares its
  non-`url` surface with `Job` via the `DeploymentHandle` base.

This keeps the anycloud-owned contract small: provision the VM, start the
container, publish the stable URL, and expose lifecycle controls.

### SkyPilot replacement mapping

The serve-side handle is a `Server`:

| SkyPilot operation         | anycloud equivalent                                                                |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `sky launch -c <name> ...` | `Client.serve(..., deployment_id=<name>)` → `Server`, then `server.wait_running()` |
| `sky status`               | `Client.list()` and `<handle>.status()`                                            |
| `sky exec <name> <cmd>`    | `server.exec(<cmd>)`                                                               |
| `sky down <name>`          | `server.terminate()`                                                               |

`sky launch` also blocks until the node is up; `server.wait_running()` is the
genuinely new operation that fills that gap (see [Server wait
semantics](#server-wait-semantics)). The `sky status` row reads
`<handle>.status()` because `status()` lives on the base — `list()` returns
stored records, not handles (see Open questions). Managing a pool is done by
launching multiple independent serve deployments, usually with a namespace
prefix. No cluster abstraction is introduced.

### Deployment handles: `Job` vs `Server`

Jobs and serve nodes are **different primitives** with opposite lifecycles, so
the SDK gives them different handles instead of overloading one `Job`. A job is a
terminal task — it runs, completes, and you `wait()` for `Completed`, then
optionally `resubmit()`. A serve node is an indefinite process with a public
`url` — it should never reach `Completed`, so waiting for it to is a footgun
(`Job.wait()` would hang forever on a healthy server), and `url` is meaningful
only for serve deployments. A shared base captures everything the two have in
common; each subclass adds only what is specific to it.

`DeploymentHandle` (base, never constructed directly) holds the identical
surface — `id`, `state()`, `status()`, `logs()`, `exec(command, *, vm=False)`,
`terminate()`, the private SSH/log/status helpers — plus one shared poll helper
`_wait_until(ready, *, timeout, poll_interval)` that both readiness waits are
built on. (The base is named `DeploymentHandle`, **not** `Deployment` —
`anycloud.types.Deployment` is already an unrelated stored-record model returned
by `Client.list()`; see Implementation notes.)

```python
class DeploymentHandle:
    """Base handle: everything common to jobs and serve nodes."""
    # id, state(), status(), logs(), exec(command, *, vm=False), terminate()
    # + private _ensure_status/_event_logs/_error_message/_ssh_exec

    def _wait_until(self, ready, *, timeout=None, poll_interval=2.0) -> "DeploymentHandle":
        """Poll status() until ready(state) is True. Raise on terminal
        failure or timeout; ready() decides which state returns.

        Job.wait passes `state == Completed`; Server.wait_running passes
        `state == Running`. Ordering is load-bearing: ready() MUST be
        checked before is_terminal, or Job.wait would raise on a
        successful Completed job (Completed is itself terminal).
        """
        deadline = time.monotonic() + timeout if timeout is not None else None
        while True:
            self.status()
            if self._state is not None:
                if ready(self._state):
                    return self
                if self._state.is_terminal:
                    raise DeploymentFailedError(
                        self._id, self._state.value,
                        self._error_message(), logs=self._event_logs(),
                    )
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"Deployment {self._id} not ready within {timeout}s")
            time.sleep(poll_interval)


class Job(DeploymentHandle):
    """Terminal task. Returned by Client.submit() and Function.submit()."""
    def wait(self, *, timeout=None, poll_interval=2.0) -> "Job":
        return self._wait_until(lambda s: s == DeploymentState.Completed,
                                timeout=timeout, poll_interval=poll_interval)
    def resubmit(self) -> "Job": ...
    # NO url, NO wait_running


class Server(DeploymentHandle):
    """Long-running serve node. Returned by Client.serve() and @serve(...).start()."""
    @property
    def url(self) -> str:
        return f"https://{self._id}.anycloud.sh"
    def wait_running(self, *, timeout=None, poll_interval=2.0) -> "Server":
        return self._wait_until(lambda s: s == DeploymentState.Running,
                                timeout=timeout, poll_interval=poll_interval)
    # NO wait, NO resubmit
```

`Client.submit(...)` returns `Job`; `Client.serve(...)` returns `Server`;
`@anycloud.serve(...).start(...)` returns `Server`. The two terminal-failure
paths collapse onto the single `_wait_until`, so failure detection,
error-message extraction, and log capture are written once.

### Server wait semantics

A job and a server wait for opposite things. `Job.wait()` returns only on
`Completed` (terminal); a healthy serve node never gets there, so `wait()` would
hang forever — which is exactly why `Server` does not have it.
`Server.wait_running()` returns when the node reaches `Running`, which is
**non-terminal** (not in `_TERMINAL_STATES`). Both are one-line specializations
of the shared `_wait_until` shown above, differing only in the readiness
predicate (`Running` vs `Completed`) — same `(timeout, poll_interval=2.0)`
signature, same failure/timeout handling (any terminal state raises
`DeploymentFailedError`, a deadline raises `TimeoutError`):

```python
server.wait_running(timeout=600)   # returns when the node reaches Running
```

`wait_running()` detects "container up," not "listener accepting requests."
App-level readiness stays the customer's `/internal/health` probe — the customer's
control plane already owns it (`find_candidate_nodes` filters `state == 'ready'`
plus a lease and probes `/internal/health`), so `wait_running()` is the only
readiness primitive anycloud needs for the first workflow. A first-party
`wait_ready()` is **deferred** until serve grows a health hook; anycloud should
not guess a daemon's readiness semantics.

### Serve decorator (programmatic image + code sync)

`Client.serve(image=...)` already launches a long-running node from a prebuilt
image, but it leaves the customer with two unsolved gaps: a custom base image still has
to bake the repo in, and there is no code sync at a pinned commit the way
`@anycloud.function` gives jobs. `@anycloud.serve` closes both by reusing the
exact `@function` git-clone machinery — same `_detect_git_info`, same
`_ANYCLOUD_FN` payload, same `BOOTSTRAP_SCRIPT` — differing only in the terminal
sink: it routes through the existing `Client.serve(...)` instead of
`Client.submit(...)` (and so returns a `Server`, not a `Job`), and tells the
bootstrap to keep the process alive instead of exiting after `fn()` returns.

The two gaps are orthogonal and both close for free: `image=` is the substrate
(OS + CUDA + deps + `git`, no app code) and the bootstrap's git-clone-at-commit
is the code, so shipping new node code is a commit + push + relaunch with no
image rebuild and no AMI rewrite. The pinned commit also makes every node in a
namespace reproducible — identical code on each — which `sky launch` against a
mutable AMI does not guarantee.

**Decorator signature.** A param-for-param mirror of `@anycloud.function`. No new
knobs: each maps to something the customer already sets.

```python
def serve(
    *,
    image: str,                       # custom base image — passed straight to Client.serve
    gpu: str | None = None,           # customer: --gpus L40S:1
    env: dict[str, str] | None = None,
    secrets: list[str] | None = None, # saved secret-set NAMES, resolved server-side
    cloud_config: CloudConfig | None = None,
    docker_options: dict[str, Any] | None = None,
    target_path: str = "/app",
):
    """Decorate a daemon entrypoint for a long-running serve node.

    Same git-clone-at-commit code sync as @anycloud.function, but the
    decorated function IS the daemon main: it starts the listener on PORT
    (anycloud sets it to 8088) and MUST block (e.g. uvicorn.run). Returns a
    ServeFunction whose .start() launches one serve deployment and returns a
    Server.
    """
```

Every param is justified by the customer's current usage: `image` (their custom CUDA
base), `gpu` (`L40S:1`), `env` (`NAMESPACE`/`REGION`), `secrets` (names of saved
secret sets such as an `inference-node` bundle, resolved server-side — not env-var
names), `cloud_config`/`docker_options` (region/shm if needed), `target_path`
(`/opt/inference`, where `stop.sh` lives). No speculative param; `map()` is omitted
per the no-cluster non-goal.

**Customer-shaped example.**

```python
# inference/serve_node.py  (committed to their repo)
import os, anycloud
from inference.daemon import app          # their existing FastAPI app: /internal/sessions, /internal/health

@anycloud.serve(
    image="ghcr.io/acme/inference:cuda12",
    gpu="L40S:1",
    secrets=["inference-node"],            # secret set bundling NODE_API_KEY, SUPABASE_*
    target_path="/opt/inference",          # clone where stop.sh already expects it
)
def node():
    import uvicorn
    # NAMESPACE/REGION come from start(env=...); the daemon self-registers into
    # Supabase nodes.url with its own URL (derived from DEPLOYMENT_ID), then BLOCKS.
    app.state.namespace = os.environ["NAMESPACE"]
    app.state.region = os.environ["REGION"]
    app.state.url = f"https://{os.environ['DEPLOYMENT_ID']}.anycloud.sh"
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ["PORT"]))  # never returns
```

```python
# control-plane autoscaler — replaces `python inference_cluster.py add model-a 1`
from serve_node import node

idx = next_index("model-a")                       # caller still owns indexing + fan-out
server = node.start(                              # returns Server
    id=f"model-a-{idx:03d}",                       # namespace-prefixed == sky launch -c <name>
    env={"NAMESPACE": "model-a", "REGION": "us"},  # the customer's self-register vars
)
server.wait_running(timeout=600)                   # back when Running (replaces waiting on sky launch)
url = server.url                                   # https://model-a-001.anycloud.sh

# graceful deregister + down  (replaces graceful_stop + `sky down`)
server.exec("cd /opt/inference && bash scripts/stop.sh")
server.terminate()
```

The daemon derives its own public URL from the injected `DEPLOYMENT_ID`
(`https://<id>.anycloud.sh`). We deliberately do **not** inject a separate
`ANYCLOUD_URL`: unlike `PORT` (which the daemon cannot derive), the URL is a pure
function of the id, so injecting it would only duplicate `DEPLOYMENT_ID`. If a
future feature makes the URL non-derivable (e.g. custom domains), inject it then,
when it becomes load-bearing (see Implementation notes).

`start()` is the serve twin of `Function.submit()`, and it returns a `Server`.
Its signature is `start(*, id=None, env=None, secrets=None)` — no
`*args`/`**kwargs`, because a daemon takes no per-call inputs; it self-configures
from injected env. `env` merges over decorator `env` exactly as `submit()` does,
so per-node `NAMESPACE`/`REGION` work the way the customer's `sky --env` flags do today.
`start()` forwards no user args, so the `submit()`-style `id`/`env`
parameter-collision guard cannot cause a start-time collision; it remains inert
for serve (daemon entrypoints take no params) — left in place, not special-cased.

**Execution model.** A serve entrypoint **is** the daemon main and must block; an
`fn` that returns is a bug. anycloud does not inject a `while True` or guess the
daemon's readiness/signal semantics — blocking is the function's explicit job.
This collapses the customer's current two-step into one: today they background the
daemon (`scripts/start.sh` into tmux) and keep the SkyPilot node alive with a
separate `tail -f /var/log/inference.log`; under `@serve` the entrypoint itself
blocks in the foreground (e.g. `uvicorn.run`), so the container stays up because
`fn()` never returns. If the VM reboots, Docker `--restart unless-stopped` (RFC 0003) re-runs the container, the bootstrap re-clones `repo@commit`, and the
daemon self-registers again on boot.

This reuses the existing `BOOTSTRAP_SCRIPT` 1:1 — same
clone/fetch/checkout/import/getattr error handling — with two minimal changes:

1. **A `serve` flag in `_ANYCLOUD_FN`** that branches only the final call site.
   For serve, the bootstrap calls bare `fn()` (expected to block); if it ever
   returns, the bootstrap prints a legible error to stderr and `sys.exit(1)` so
   `server.logs()` shows it, instead of a silent clone-import-exit restart loop.
   `_ANYCLOUD_FN` carries `args=[], kwargs={}, serve=True` (the `args`/`kwargs`
   are written only for shape-consistency with the job payload; the serve arm
   calls bare `fn()` and never reads them). The serve arm deliberately omits the
   job arm's `try/except` wrapper — a daemon that raises should surface its own
   traceback raw:

   ```python
       fn = getattr(mod, config["name"])
       if config.get("serve"):
           fn()                       # daemon: must block
           print("ERROR: @anycloud.serve entrypoint returned without blocking; "
                 "a serve node must keep its process alive (e.g. uvicorn.run).",
                 file=sys.stderr)
           sys.exit(1)
       else:
           try:
               fn(*config["args"], **config["kwargs"])   # job: returns, then exit 0
           except Exception:
               print(f"ERROR: your function {config['name']!r} raised an exception:",
                     file=sys.stderr)
               raise
   ```

2. **The in-container `anycloud` stub must also stub `.serve`.** The bootstrap's
   `ImportError` branch today sets only `stub.function = lambda **kw: lambda fn: fn`.
   A module that does `import anycloud` and decorates with `@anycloud.serve` would
   `AttributeError` on any remote without the real package. Add one line in the
   same branch:

   ```python
       stub.serve = lambda **kw: lambda fn: fn
   ```

`ServeFunction.start()` is a near-copy of `Function._submit_resolved` that swaps
the terminal call from `client.submit(...)` to `client.serve(...)` — and
therefore returns a `Server`. Every kwarg the function path passes carries over —
including `gpu=self._gpu`, without which a `gpu="L40S:1"` node would launch with
no accelerator:

```python
return client.serve(                                 # -> Server
    self._image,
    gpu=self._gpu,                                   # carries over from @function — do not drop
    command=["python", "-c", BOOTSTRAP_SCRIPT],
    env=submit_env,
    secrets=merged_secrets,
    cloud_config=cloud_config,
    docker_options=self._docker_options,
    deployment_id=id,
    credential_name=credential_name,
)
```

`client.serve` already accepts exactly these kwargs, so no new client method is
needed. The module/dir/git resolution and `_resolve_cloud_config` are factored
into a shared internal wrapper base so the function and serve wrappers differ
only in `submit` vs `start` and `client.submit` vs `client.serve` — internal
reuse, not new public surface. The decorator preserves `@function`'s in-container
guard (`if os.environ.get("_ANYCLOUD_FN"): return fn`) so the module imports
cleanly both locally and on the node.

`node.start(id=...)` is the ergonomic form of the [SkyPilot
mapping](#skypilot-replacement-mapping)'s `Client.serve(..., deployment_id=)`
launch row, then `server.wait_running()`; `server.status()`/`server.exec(...)`/
`server.terminate()` are unchanged. On the customer's side, `make_yaml_with_image`,
`AWS_DL_AMI`, and `sky/inference.yaml` are deleted — the image is a plain ref and code
arrives by clone — while `next_index()` and the parallel launch loop stay
(anycloud owns node lifecycle; the customer owns indexing and fan-out). `rpc.py`
(reservation + `/internal/sessions` dispatch), the Supabase `nodes` table,
`stop.sh`, and `X-API-Key` auth are untouched.

### Port exposure & dispatch target

The customer's app dispatches to a node with `httpx.AsyncClient(timeout=2.0,
verify=False)`, posting to `{node_url}/internal/sessions` with an `X-API-Key`
header, and health-probes `{node_url}/internal/health` the same way
(`verify=False`). Today `node_url` is whatever the daemon registered into
Supabase `nodes.url`; under this RFC the launcher writes that value. Two targets
are possible, and they are not interchangeable. Both first require one app-side
change: the daemon must bind `$PORT` (8088) rather than whatever fixed port it
registers today, because the serve contract publishes the container on 8088 (see
note).

**Target A — the proxied front door (`https://<deployment-id>.anycloud.sh`).**
This is the only URL `server.url` returns today. It gives the customer a trusted public
cert and hides the origin IP, and under RFC 0004 the origin firewall is locked to
Cloudflare's ranges so direct-to-origin bypass stops working. Two constraints
follow from routing through Cloudflare:

- _Edge hop._ Every `/internal/sessions` POST traverses the Cloudflare edge
  instead of going straight to the VM. The customer's dispatch timeout is `2.0s`; the
  added edge latency is small but real, and it competes with that budget on the
  session-create hot path.
- _Proxiable-port restriction._ Cloudflare's proxy forwards only a fixed set of
  ports (HTTPS: 443, 2053, 2083, 2087, 2096, 8443; HTTP: 80, 8080, 8880, 2052,
  2082, 2086, 2095). Neither the customer's old 8081 nor the serve container's 8088 is
  in that set — but the proxied port need not be: the daemon binds container port
  8088 (`$PORT`, RFC 0003), RFC 0003 publishes that as host `0.0.0.0:80:8088`,
  and Cloudflare proxies the origin's **port 80** (which _is_ proxiable) while
  terminating TLS on 443. So the customer reaches the node as
  `https://<id>.anycloud.sh` (443) with no `:port` in the URL, and can drop
  `verify=False` since the edge cert is real.

**Target B — direct to the node IP:port with scoped ingress.** The customer resolves the
node to `<vm-ip>:<port>` and posts straight to it, skipping the edge — the
lowest-latency option, keeping the customer's existing `verify=False` posture
(self-signed / no origin cert). It depends on the RFC 0004 `ipWhitelist` work,
which is **not yet enforced**: SSH ingress is still effectively `0.0.0.0/0` and
HTTP-origin scoping is the RFC 0004 §3 deliverable. Until that lands, "direct"
means an open origin port guarded only by `X-API-Key` — the exact posture RFC
0004 exists to remove. There is also no first-class dispatch-IP accessor today:
`server.url` is the edge URL, and the raw IP lives only in the untyped
`status().vms` list — the `ip` field of the live VM dict (the entry whose
`endedAt is None`), the same value `server.exec` SSHes to. Alternate-port publish
(only host `80→8088` exists today) and enforced `ipWhitelist` are both unbuilt
prerequisites for this path.

**Recommendation: default to Target A, with the customer serving on `$PORT`.** It works
on day one against the shipped serve contract — no dependency on the unfinished
RFC 0004 `ipWhitelist` path — and gives a trusted cert and origin hiding for free.
The adaptations are customer-side and cheap: bind the daemon to `$PORT` (8088), and
route `/internal/sessions` and `/internal/health` through
`https://<id>.anycloud.sh`. The anycloud-owned contract stays unchanged: one
stable URL, no second ingress surface, no scoped-CIDR knob.

**Deciding question:** does the customer's `2.0s` dispatch budget tolerate the
Cloudflare edge hop? If measured edge round-trips stay comfortably inside `2.0s`,
Target A is correct and Target B is unnecessary. Only if the edge hop proves to
eat the budget should we fall back to Target B — gated on RFC 0004 `ipWhitelist`
enforcement landing and on the customer supplying/refreshing the per-node ingress CIDR.

> **Note on the listen port.** `PORT` is fixed at `8088` (RFC 0003 sets
> `PORT=8088` and publishes `0.0.0.0:80:8088`; `Client.serve()` has no port
> parameter). It is not configurable; the decorated daemon reads `$PORT` and
> binds to it. A configurable listen port is out of scope here.

### Graceful deregistration

The v0 graceful shutdown pattern is explicit and app-owned:

```python
server.exec("cd /opt/inference && bash scripts/stop.sh")
server.terminate()
```

This mirrors the existing SkyPilot `stop.sh` before `sky down` pattern. A
first-class `server.terminate(pre_stop=..., timeout=...)` helper is a useful
follow-up, but not required for the first programmatic node workflow.

### Headless control-plane use

Production users will call the SDK from their backend/autoscaler, not from a
developer terminal.

The supported near-term shape is:

- run `anycloud api` as a service or sidecar near the customer control plane;
- store the cloud credentials there using the normal credential flow;
- point the SDK at that API via `api_url` / `API_URL`;
- let the customer's backend call `Client.serve`, `list`, `status`, `exec`, and
  `terminate`.

A hosted control plane or service-account auth model can be considered later,
but this RFC does not require it.

## Non-goals

Do not build anycloud-owned serving semantics for this milestone:

- no request-path router;
- no session affinity ledger;
- no LiveKit/Daily dispatch;
- no Supabase-style capacity reservation;
- no autoscaling policy;
- no multi-VM service behind one stable endpoint;
- no WebRTC media hosting beyond the HTTPS/WSS serve endpoint from RFC 0003;
- no cluster abstraction over many serve deployments.

## Alternatives considered

### Build a multi-VM anycloud serving plane

That would require router placement, health, affinity, drain, and scaling
policy. It is the wrong first customer-driven step because the customer already owns
those concerns and wants to keep them.

### Model node pools as jobs

Jobs complete, sync artifacts, and can use spot/checkpoint paths. Serve nodes
are indefinite processes with a public URL and runtime lifecycle operations.
Keeping them as `serve` deployments preserves the right lifecycle boundary.

### Add a first-class cluster abstraction

The current product deliberately avoids clusters. For this use case, a namespace
prefix plus multiple independent deployment handles is sufficient and maps
cleanly onto the customer's existing control plane.

## Risks & caveats

- Many long-running serve deployments will increase monitor/list/status load.
- Public node URLs must still be protected by the customer's app auth until
  RFC 0004 hardening lands.
- Without anycloud-owned drain, deregistration correctness depends on the
  customer's `stop.sh` or equivalent hook.
- The local `anycloud api` process becomes production infrastructure when used
  from a backend/autoscaler.

## Open questions

- Should `Client.get(id)` dispatch on `deploymentType` to return `Server` vs
  `Job` (one `status()` round-trip), instead of today's unconditional `Job`? This
  is the real re-attach path: an autoscaler resuming a node by id to run
  `stop.sh` + `terminate()` currently gets a `Job` with no `url`/`wait_running()`.
  (`Client.list()` returns stored `types.Deployment` records, not handles, so
  there is no subclass to choose there.)
- Should `Client.list()` gain a server-side prefix/type filter, or is client-side
  filtering enough for v1?
- Should `terminate(pre_stop=..., timeout=...)` be first-class or remain a
  documented `exec` + `terminate` pattern?
- Dispatch target: does the customer's `2.0s` budget tolerate the Cloudflare edge hop
  (Target A)? If not, Target B (direct node IP:port) requires both an
  alternate-port publish and enforced RFC 0004 `ipWhitelist` — neither built
  today — plus a first-class dispatch-IP accessor (only the raw `ip` field in the
  untyped `status().vms` live-VM dict exists).

## Implementation notes / breaking changes

Pre-1.0 (package is `0.1.30`): the handle split is clean renames/moves with **no
back-compat shims**.

- **Do not inject `ANYCLOUD_URL`.** The serve container already gets
  `DEPLOYMENT_ID` (and `PORT`); the public URL `https://<id>.anycloud.sh` is a
  pure function of the id, so the daemon derives it rather than reading a
  redundant injected var (nothing in anycloud reads `ANYCLOUD_URL` either).
  Revisit only if a future feature (e.g. custom domains) makes the URL
  non-derivable, at which point injecting it becomes load-bearing.
- **Handle base is `DeploymentHandle`, not `Deployment`** — `anycloud.types.Deployment`
  is the existing stored-record model returned by `Client.list()`. `Job`/`Server`
  subclass `DeploymentHandle`; `list()` keeps returning `types.Deployment`.
- **`Client.serve(...)` return type changes `Job → Server`** (and
  `@anycloud.serve(...).start(...)` returns `Server`); `Client.submit(...)` still
  returns `Job`. Update the `Client.serve` docstring (`-> Server`, `server.url`).
  Callers that relied on `serve()` returning a `Job` (e.g. to call
  `.wait()`/`.resubmit()`) switch to `.wait_running()`; those methods are
  intentionally absent on `Server`.
- **`url` moves off `Job` onto `Server`** — the only handle where a public node
  URL is meaningful. `Job` no longer exposes `url`; update the docstring
  (currently "for deployments created with `Client.serve()`").
- **`JobFailedError → DeploymentFailedError`, no alias** — raised by the shared
  `_wait_until` for both `Job.wait()` and `Server.wait_running()`, so the rename
  reaches the constructor (`job_id → deployment_id`), the `.job_id` attribute →
  `.deployment_id`, and the message prefix `"Job {id} {state}"` →
  `"Deployment {id} {state}"`. Sweep `errors.py`, `__init__.py` (`__all__`), and
  the `job.py` docstring references. `JobGroupError`/`BatchSubmitError` stay
  job-only — out of scope.
- **`Job`, `Server`, and their distinct methods are factored onto a shared
  `DeploymentHandle` base.** The common surface (`id`, `status`, `state`, `logs`,
  `exec`, `terminate`, SSH/log internals, `_wait_until`) lives there once;
  `wait()`/`resubmit()` are on `Job`, `wait_running()`/`url` on `Server`. Keep
  `poll_interval=2.0` as the default and the `ready()`-before-`is_terminal` check
  ordering in `_wait_until` (reversing it makes `Job.wait` raise on a successful
  `Completed` job).

## Decision

Rejected as a complete product design. The independent node lifecycle and
`Client.serve(image, command=...)` handle shipped in
an earlier PR, but the proposed
Python repository/code-sync decorator layer was removed in
a later PR. The surviving SDK
handle is supported; the decorator and Git-sync sections above are historical,
not a roadmap commitment.
