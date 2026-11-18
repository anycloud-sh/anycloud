"""Persistent Deployment application for managed-Kubernetes qualification."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import Protocol, TypeVar
from urllib.parse import quote, urlparse

import httpx

from anycloud.exceptions import ApiException
from anycloud_workflows import CurrentJob, current_deployment

_T = TypeVar("_T")
_STALE_STATUSES = {404, 409}
_LOG_LOCK = threading.Lock()


class StaleJob(Exception):
    pass


class Held(Protocol):
    """Work a held Job keeps running until its cancellation."""

    def poll(self) -> None: ...

    def stop(self) -> None: ...


# A GPU workload profile: fresh work for one execution, raising unless it is
# right; a held Job's work is returned to keep running until cancelled.
Work = Callable[[CurrentJob, str], "Held | None"]


def log(message: str) -> None:
    # Job handlers, cancellation watchers and the egress probe publish
    # independently. One write per record keeps it whole beside the unlocked
    # AC_TIMING prints under PYTHONUNBUFFERED; the lock covers buffering.
    with _LOG_LOCK:
        print(message + "\n", end="", flush=True)


def timing(name: str, **extra: object) -> None:
    """One AC_TIMING mark (mace-first-inference.py's line), epoch ms."""
    log("AC_TIMING " + json.dumps(
        {"name": name, "epochMs": time.time_ns() // 1_000_000, **extra}, sort_keys=True
    ))


def prove_dns() -> None:
    for _attempt in range(5):
        try:
            socket.getaddrinfo("example.com", 443)
            return
        except OSError:
            time.sleep(2)
    raise RuntimeError("workload DNS resolution failed")


def prove_gpu(job_id: str) -> None:
    """The live GPU pool check: every Job must see its device before it runs."""
    devices = [
        line
        for line in subprocess.check_output(
            ["nvidia-smi", "-L"], text=True, timeout=60
        ).splitlines()
        if line.startswith("GPU ")
    ]
    if not devices:
        raise RuntimeError("nvidia-smi -L listed no GPU")
    log("GPU_DEVICES " + json.dumps({"jobId": job_id, "devices": devices}))


def retry_job_operation(operation: str, call: Callable[[], _T]) -> _T:
    while True:
        try:
            return call()
        except ApiException as error:
            if error.status in _STALE_STATUSES:
                raise StaleJob from error
            log(f"{operation} retrying after {error}")
        except (httpx.HTTPError, OSError, ValueError) as error:
            log(f"{operation} retrying after {error}")
        time.sleep(1)


class CancellationWatcher:
    """Observe cancellation while the Deployment application handles its Job."""

    def __init__(self, job: CurrentJob) -> None:
        self.job = job
        self.result: Future[bool] = Future()
        self.waiting = threading.Event()
        self.stopping = threading.Event()
        self.thread = threading.Thread(
            target=self._run, daemon=True, name=f"cancel-{job.id}"
        )
        self.thread.start()

    def _run(self) -> None:
        try:
            while not self.stopping.is_set():
                try:
                    self.waiting.set()
                    log(f"cancellation-wait:{self.job.id}:20")
                    try:
                        cancelled = self.job.cancellation_requested(timeout=20)
                    finally:
                        self.waiting.clear()
                    if cancelled:
                        log(f"cancellation-observed:{self.job.id}")
                        self.result.set_result(True)
                        return
                except ApiException as error:
                    if error.status in _STALE_STATUSES:
                        raise StaleJob from error
                    log(f"cancellation:{self.job.id} retrying after {error}")
                    self.stopping.wait(1)
                except (httpx.HTTPError, OSError, ValueError) as error:
                    log(f"cancellation:{self.job.id} retrying after {error}")
                    self.stopping.wait(1)
            self.result.set_result(False)
        except Exception as error:
            self.result.set_exception(error)

    def cancelled(self) -> bool:
        # A stale execution or unexpected watcher failure must stop local work.
        return self.result.done() and self.result.result()

    def close(self) -> None:
        self.stopping.set()
        # Publish the outcome before joining: it wakes the outstanding request.
        self.thread.join(timeout=35)
        if self.thread.is_alive():
            raise RuntimeError(f"cancellation watcher did not stop for {self.job.id}")
        log(f"cancellation-watcher-closed:{self.job.id}")


class ReservationStore:
    def __init__(self, base_url: str) -> None:
        self._http = httpx.Client(base_url=f"{base_url.rstrip('/')}/", timeout=5)

    def lookup(self, job_id: str) -> str | None:
        response = self._http.get(quote(job_id, safe=""))
        if response.status_code == 404:
            return None
        response.raise_for_status()
        value = response.json()
        if not isinstance(value, dict) or not isinstance(value.get("behavior"), str):
            raise ValueError("reservation store returned an invalid response")
        return value["behavior"]


class JobIdBehavior:
    """E2E_COMPLETE_JOB_IDS (the live cluster check, no reservation store): a listed Job completes, any other holds.

    E2E_FRESH_REPLICA_COMPLETE_JOB_IDS: a listed Job holds on a replica that
    already claimed a Job and completes on a fresh one, as a session retried
    onto a replacement replica does. Each is decided once, at its claim.
    """

    def __init__(self, complete: str, fresh_replica_complete: str = "") -> None:
        self._complete = set(complete.split(","))
        self._fresh = {job_id for job_id in fresh_replica_complete.split(",") if job_id}
        self._claims = 0
        self._decided: dict[str, str] = {}

    def claimed(self, job_id: str) -> None:
        if job_id in self._fresh and job_id not in self._decided:
            self._decided[job_id] = "complete" if self._claims == 0 else "hold"
        self._claims += 1

    def lookup(self, job_id: str) -> str:
        if job_id in self._decided:
            return self._decided[job_id]
        return "complete" if job_id in self._complete else "hold"


def wait_for_reservation(
    store: ReservationStore | JobIdBehavior, job_id: str
) -> str | None:
    while True:
        try:
            return store.lookup(job_id)
        except (httpx.HTTPError, ValueError) as error:
            log(f"reservation:{job_id} retrying after {error}")
            time.sleep(1)


def handle_job(
    store: ReservationStore | JobIdBehavior,
    job: CurrentJob,
    work: Work | None = None,
) -> None:
    job_id = job.id
    watcher: CancellationWatcher | None = None
    held: Held | None = None

    def acknowledge(outcome: str, call: Callable[[], None]) -> None:
        nonlocal held
        # Release held work first: the outcome frees the Deployment's capacity,
        # and the next Job must find its slot free.
        if held is not None:
            held.stop()
            held = None
        waiting = watcher is not None and watcher.waiting.is_set()
        if watcher is not None:
            watcher.stopping.set()
        retry_job_operation(f"{outcome}:{job_id}", call)
        if waiting:
            log(f"{outcome}-with-cancellation-wait:{job_id}")

    log(f"started:{job_id}")
    log(f"configuration:{job_id}:{os.environ.get('CONFIGURATION_MARKER', '')}")
    try:
        if os.environ.get("E2E_REQUIRE_GPU") == "1":
            prove_gpu(job_id)
            if work is None:
                raise RuntimeError("GPU receiver runs without a workload profile")
        behavior = wait_for_reservation(store, job_id)
        if behavior is None:
            acknowledge(
                "invalid",
                lambda: job.invalid("reservation not found"),
            )
            log(f"invalid:{job_id}")
            return

        # The deliberate runtime-loss case must keep ignoring cancellation.
        if behavior != "hold-no-cancel":
            watcher = CancellationWatcher(job)

        log("WORK_STARTED " + json.dumps({
            "jobId": job_id,
            "executionId": str(job.selected.execution_id),
        }, sort_keys=True))

        if behavior == "oom":
            # Past the Deployment's --memory: the kernel kills the replica.
            ballast = b"\x01" * (1 << 30)
            log(f"oom-survived:{job_id}:{len(ballast)}")

        # Fresh work belongs to this execution, including attempts
        # intentionally held or retried before their terminal acknowledgement.
        # Work that misses its reference raises and errors the Job.
        if work is not None and behavior != "error":
            held = work(job, behavior)

        while True:
            if held is not None:
                held.poll()
            if watcher is not None and watcher.cancelled():
                acknowledge("cleanup", job.cleanup)
                log(f"cancelled:{job_id}")
                return
            current = wait_for_reservation(store, job_id)
            if current is None:
                time.sleep(1)
                continue
            if current == "complete":
                acknowledge("completed", job.complete)
                log(f"completed:{job_id}")
                return
            if current == "error":
                acknowledge(
                    "errored",
                    lambda: job.error("fixture error"),
                )
                log(f"errored:{job_id}")
                return
            if current == "retry":
                acknowledge(
                    "retry",
                    lambda: job.retry("fixture retry"),
                )
                log(f"retry:{job_id}")
                return
            if watcher is not None:
                # Application reservation checks remain independent of the wait.
                # A cancellation wakes the simulated task without a sleep delay.
                try:
                    watcher.result.result(timeout=1)
                except FutureTimeoutError:
                    pass
            else:
                time.sleep(1)
    except StaleJob:
        log(f"stale:{job_id}")
    except Exception as error:
        message = str(error)
        log(f"failed:{job_id}:{message}")
        try:
            acknowledge("errored", lambda: job.error(message))
        except StaleJob:
            log(f"stale:{job_id}")
    finally:
        if held is not None:
            held.stop()
        if watcher is not None:
            watcher.close()


def mace_work(run: Callable[[CurrentJob], dict[str, object]]) -> Work:
    def work(job: CurrentJob, _behavior: str) -> None:
        log("MACE_INFERENCE " + json.dumps(run(job), sort_keys=True))

    return work


def load_work() -> Work | None:
    profile = os.environ.get("E2E_WORKLOAD_PROFILE", "")
    if not profile:
        return None
    try:
        if profile == "mace-cuda":
            from mace_inference import MaceInference

            return mace_work(MaceInference().run)
        if profile == "voice":
            from voice_session import VoiceWork

            canaries = os.environ.get("E2E_VOICE_CANARY_JOB_IDS", "")
            return VoiceWork(set(filter(None, canaries.split(","))))
        raise ValueError(f"unknown workload profile {profile}")
    except Exception as error:
        # Keep receiving: every Job then errors with the reason, instead
        # of the harness waiting out a crash-looping Pod.
        reason = f"{profile} failed to load: {error}"
        log(reason)

        def failed(_job: CurrentJob, _behavior: str) -> None:
            raise RuntimeError(reason)

        return failed


def connect_error(address: tuple[str, int]) -> str:
    """Why a TCP connection to the address failed, or "" when it opened."""
    try:
        socket.create_connection(address, timeout=5).close()
    except TimeoutError:
        return "timeout"
    except OSError as error:
        return errno.errorcode.get(error.errno or 0, type(error).__name__)
    return ""


def probe_egress() -> None:
    """K5's egress policy as this replica meets it.

    Records the Node's resolvers (the replica resolves through its Node), whether
    the workload API host resolves through them, and whether the instance
    metadata HTTP port answers; on Azure, also the WireServer's ports.
    The harness reads the one `EGRESS_PROBE` line.
    """
    with open("/etc/resolv.conf", encoding="utf-8") as resolv:
        nameservers = [
            line.split()[1]
            for line in resolv
            if line.startswith("nameserver") and len(line.split()) > 1
        ]
    host = urlparse(os.environ["ANYCLOUD_API_URL"]).hostname or ""
    resolved = False
    for _attempt in range(5):
        try:
            socket.getaddrinfo(host, 443)
            resolved = True
            break
        except OSError:
            time.sleep(2)
    metadata_error = connect_error(("169.254.169.254", 80))
    wire_server = (
        {"wireServerErrors": {str(port): connect_error(("168.63.129.16", port)) for port in (80, 32526)}}
        if os.environ.get("E2E_WIRESERVER_PROBE") == "1"
        else {}
    )
    log(
        "EGRESS_PROBE "
        + json.dumps(
            {
                "nameservers": nameservers,
                "apiHostResolved": resolved,
                "metadataHttp": "denied" if metadata_error else "reachable",
                "metadataError": metadata_error,
                **wire_server,
            }
        )
    )


def main() -> None:
    timing("process_start")
    prove_dns()
    if os.environ.get("E2E_EGRESS_PROBE") == "1":
        # Its blocked connects wait out their timeouts, so the probe
        # runs beside the model load; the harness waits for its line.
        threading.Thread(target=probe_egress, daemon=True, name="egress-probe").start()
    # A named Secret's value is proven by its digest; the value is never logged.
    token = os.environ.get("SERVE_SECRET_TOKEN")
    if token is not None:
        log("SECRET_SHA256 " + hashlib.sha256(token.encode()).hexdigest())
    store: ReservationStore | JobIdBehavior
    complete_job_ids = os.environ.get("E2E_COMPLETE_JOB_IDS", "").strip()
    if complete_job_ids:
        store = JobIdBehavior(
            complete_job_ids,
            os.environ.get("E2E_FRESH_REPLICA_COMPLETE_JOB_IDS", "").strip(),
        )
    else:
        reservation_base_url = os.environ.get("RESERVATION_BASE_URL", "").strip()
        if not reservation_base_url:
            raise ValueError("RESERVATION_BASE_URL is required")
        store = ReservationStore(reservation_base_url)
    work = load_work()
    timing("work_loaded")
    first_claim = True
    idle_stop = os.environ.get("IDLE_STOP_RESERVATION", "").strip()
    with current_deployment() as deployment:
        receive_sequence = 0
        while True:
            receive_sequence += 1
            receive_started = time.time_ns() // 1_000_000
            log("RECEIVE_STARTED " + json.dumps({
                "sequence": receive_sequence,
                "startedAt": receive_started,
            }, sort_keys=True))
            try:
                log("receive-wait:20")
                job = deployment.next_job(timeout=20)
            except (ApiException, httpx.HTTPError, OSError, ValueError) as error:
                log("RECEIVE_FINISHED " + json.dumps({
                    "sequence": receive_sequence,
                    "returnedAt": time.time_ns() // 1_000_000,
                    "jobId": None,
                    "probeSucceededAt": None,
                }, sort_keys=True))
                log(f"next_job retrying after {error}")
                time.sleep(1)
                continue
            returned_at = time.time_ns() // 1_000_000
            marker = Path("/tmp/anycloud-readiness-success-ms")
            try:
                probe_succeeded_at = int(marker.read_text())
            except FileNotFoundError:
                probe_succeeded_at = None
            log("RECEIVE_FINISHED " + json.dumps({
                "sequence": receive_sequence,
                "returnedAt": returned_at,
                "jobId": job.id if job is not None else None,
                "probeSucceededAt": probe_succeeded_at,
            }, sort_keys=True))
            if job is None:
                if idle_stop:
                    log(f"idle-stopped:{idle_stop}")
                    while wait_for_reservation(store, idle_stop) != "complete":
                        time.sleep(1)
                    idle_stop = ""
                continue
            if first_claim:
                timing("first_claim", jobId=job.id)
                first_claim = False
            if isinstance(store, JobIdBehavior):
                store.claimed(job.id)
            threading.Thread(
                target=handle_job,
                args=(store, job, work),
                daemon=True,
                name=f"job-{job.id}",
            ).start()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise
