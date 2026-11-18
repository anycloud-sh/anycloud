"""Focused generated-HTTP checks for Deployment discovery and exact claim recovery."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

import httpx
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration
from anycloud.exceptions import ApiException
from anycloud.models.get_deployment_job_cancellation409_response import (
    GetDeploymentJobCancellation409Response,
)
from anycloud.models.selected_job import SelectedJob
from anycloud.models.undefined_api_error import UndefinedApiError
from anycloud.models.workload_conflict_api_error import WorkloadConflictApiError
from anycloud.models.workload_execution_used_api_error import WorkloadExecutionUsedApiError
from anycloud.sync_helper import run_sync
from anycloud_workflows import DeploymentContext, DeploymentJobPoller
from anycloud_workflows._request_deadline import RequestDeadlineExceeded
import anycloud_workflows.deployment_jobs as deployment_jobs
import anycloud_workflows.deployments as deployments


def candidate(job_id: str = "job-1", revision: int = 2, previous: str | None = None) -> httpx.Response:
    return httpx.Response(200, json={
        "jobId": job_id, "submissionRevision": revision, "previousExecutionId": previous,
    })


def selected(request: httpx.Request, job_id: str = "job-1") -> httpx.Response:
    return httpx.Response(200, json={
        "jobId": job_id, "executionId": request.headers["Idempotency-Key"],
    })


def conflict(code: str = "WORKLOAD_CONFLICT") -> httpx.Response:
    return httpx.Response(409, json={
        "defined": True, "code": code, "status": 409, "message": "Claim rejected",
    })


def client_for(handler: object) -> ApiClient:
    client = ApiClient(Configuration(host="https://api.example.test/v1", access_token="token"))
    client.rest_client.pool_manager = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


def expect_error(error_type: type[BaseException], operation: object) -> BaseException:
    try:
        operation()
    except error_type as error:
        return error
    raise AssertionError(f"Expected {error_type.__name__}")


def qualify_exact_recovery() -> None:
    requests: list[httpx.Request] = []
    claims = 0
    previous = "00000000-0000-4000-8000-000000000099"

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal claims
        requests.append(request)
        if request.method == "GET":
            return candidate(previous=previous)
        claims += 1
        if claims == 1:
            raise httpx.RemoteProtocolError("response lost")
        if claims == 2:
            return conflict()
        if claims == 3:
            return httpx.Response(503, json={"error": "Temporarily unavailable"})
        if claims == 4:
            return selected(request, "wrong-job")
        if claims == 5:
            return httpx.Response(200, json={"jobId": "job-1", "executionId": previous})
        return selected(request)

    client = client_for(handler)
    try:
        poller = DeploymentJobPoller(client, "deployment-1")
        expect_error(httpx.RemoteProtocolError, lambda: poller.next_job(timeout=0))
        pending = poller._pending
        assert pending is not None
        for timeout, error_type in ((20, ApiException), (0, ApiException), (1, ValueError), (0, ValueError)):
            expect_error(error_type, lambda: poller.next_job(timeout=timeout))
            assert poller._pending is pending
        job = poller.next_job(timeout=0)
        assert job is not None and job.job_id == "job-1"
        assert poller._pending is None
        assert len([request for request in requests if request.method == "GET"]) == 1
        assert len({request.headers["Idempotency-Key"] for request in requests[1:]}) == 1
        assert all(json.loads(request.content) == {
            "submissionRevision": 2, "previousExecutionId": previous,
        } for request in requests[1:])
    finally:
        run_sync(client.close())


def qualify_conclusive_and_empty() -> None:
    operations: list[str] = []
    empty_wait_windows: list[int] = []
    reply = "empty"

    async def handler(request: httpx.Request) -> httpx.Response:
        operations.append(request.url.path.split("/")[-1])
        if request.method == "GET":
            assert "Idempotency-Key" not in request.headers
            if reply == "empty":
                empty_wait_windows.append(int(request.url.params["waitMs"]))
                return httpx.Response(204)
            return candidate()
        assert json.loads(request.content)["previousExecutionId"] is None
        if reply == "temporary":
            return conflict()
        return conflict(reply)

    client = client_for(handler)
    try:
        poller = DeploymentJobPoller(client, "deployment-1")
        with patch.object(deployment_jobs, "uuid4", side_effect=AssertionError("Empty discovery allocated a UUID")):
            assert poller.next_job() is None
            assert poller.next_job(0) is None
        assert 0 < empty_wait_windows[0] <= 20000
        assert empty_wait_windows[1] == 0
        reply = "temporary"
        error = expect_error(ApiException, lambda: poller.next_job(timeout=0))
        assert isinstance(error.data, GetDeploymentJobCancellation409Response)
        assert isinstance(error.data.actual_instance, WorkloadConflictApiError)
        assert poller._pending is not None
        reply = "WORKLOAD_CANDIDATE_STALE"
        before = len(operations)
        assert poller.next_job(timeout=0) is None
        assert operations[before:] == ["claim"]
        assert poller._pending is None
        reply = "WORKLOAD_EXECUTION_USED"
        error = expect_error(ApiException, lambda: poller.next_job(timeout=0))
        assert error.status == 409 and poller._pending is None
        assert isinstance(error.data, GetDeploymentJobCancellation409Response)
        assert isinstance(error.data.actual_instance, WorkloadExecutionUsedApiError)
        reply = "WORKLOAD_CANDIDATE_STALE"
        assert poller.next_job(timeout=0) is None
        assert operations[-2:] == ["candidate", "claim"]
        before = len(operations)
        started = time.monotonic()
        assert poller.next_job(timeout=0.16) is None
        elapsed = time.monotonic() - started
        assert 0.14 <= elapsed < 0.7
        assert 2 <= len(operations) - before <= 4
    finally:
        run_sync(client.close())


def qualify_unrecognized_claim_errors() -> None:
    requests: list[httpx.Request] = []
    previous = "00000000-0000-4000-8000-000000000099"
    failures = [
        (httpx.Response(409), None),
        (httpx.Response(409, text="{"), None),
        (httpx.Response(409, json={"code": "WORKLOAD_CANDIDATE_STALE"}), None),
        (httpx.Response(409, json={"code": "WORKLOAD_EXECUTION_USED"}), None),
        (httpx.Response(409, json={
            "defined": False, "code": "WORKLOAD_CANDIDATE_STALE",
            "status": 409, "message": "Not a defined stale response",
        }), None),
        (httpx.Response(409, json={
            "defined": False, "code": "UNKNOWN_CONFLICT",
            "status": 409, "message": "Unrecognized conflict",
        }), UndefinedApiError),
        (conflict(), WorkloadConflictApiError),
    ]
    response = failures[0][0]

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return candidate(previous=previous)
        return response if response is not None else selected(request)

    client = client_for(handler)
    try:
        poller = DeploymentJobPoller(client, "deployment-1")
        pending = None
        for response, expected_type in failures:
            error = expect_error(ApiException, lambda: poller.next_job(timeout=0))
            if expected_type is None:
                assert error.data is None
            else:
                assert isinstance(error.data, GetDeploymentJobCancellation409Response)
                assert isinstance(error.data.actual_instance, expected_type)
            assert poller._pending is not None
            if pending is None:
                pending = poller._pending
            assert poller._pending is pending
        response = None
        job = poller.next_job(timeout=0)
        assert job is not None and job.execution_id == pending.execution_id
        assert poller._pending is None
        assert len([request for request in requests if request.method == "GET"]) == 1
        assert all(request.headers["Idempotency-Key"] == str(pending.execution_id)
                   and json.loads(request.content) == {
                       "submissionRevision": 2, "previousExecutionId": previous,
                   } for request in requests[1:])
    finally:
        run_sync(client.close())


def qualify_late_discovery_and_shared_budget() -> None:
    requests: list[httpx.Request] = []
    discovery_delay = 0.5
    claim_delay = 0.0

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        await asyncio.sleep(discovery_delay if request.method == "GET" else claim_delay)
        return candidate() if request.method == "GET" else selected(request)

    client = client_for(handler)
    try:
        poller = DeploymentJobPoller(client, "deployment-1", request_timeout_seconds=1)
        assert poller.next_job(timeout=0.3) is None
        assert len(requests) == 1 and poller._pending is None
        discovery_delay = 0.06
        poller = DeploymentJobPoller(client, "deployment-1", request_timeout_seconds=0.03)
        expect_error(RequestDeadlineExceeded, lambda: poller.next_job(timeout=0.01))
        # A loaded runner can spend the budget before discovery is sent.
        assert all(request.method == "GET" for request in requests) and poller._pending is None
        # The claim never answers, so the deadline always lands on it. The
        # budget leaves discovery ample room to finish first on a loaded
        # runner; the claim's read timeout is what discovery left.
        discovery_delay, claim_delay = 0.07, 30
        poller = DeploymentJobPoller(client, "deployment-1", request_timeout_seconds=1)
        started = time.monotonic()
        expect_error(RequestDeadlineExceeded, lambda: poller.next_job(timeout=20))
        assert time.monotonic() - started < 5
        assert poller._pending is not None
        assert requests[-1].method == "POST"
        assert requests[-1].extensions["timeout"]["read"] <= 1 - discovery_delay
        discovery_delay = claim_delay = 0
        assert poller.next_job(timeout=0) is not None
        assert requests[-1].headers["Idempotency-Key"] == requests[-2].headers["Idempotency-Key"]
    finally:
        run_sync(client.close())


def qualify_cancellation_ordering() -> None:
    started = threading.Event()
    release = threading.Event()
    committed = threading.Event()
    mode = "discovery"
    attempts = 0
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        requests.append(request)
        delayed = request.method == "GET" if mode == "discovery" else request.method == "POST"
        if delayed:
            attempts += 1
            if attempts == 1:
                started.set()
                try:
                    while not release.is_set():
                        await asyncio.sleep(0.005)
                except asyncio.CancelledError:
                    while not release.is_set():
                        await asyncio.sleep(0.005)
                if mode == "claim":
                    committed.set()
            elif not committed.is_set():
                return conflict()
        return candidate() if request.method == "GET" else selected(request)

    client = client_for(handler)
    try:
        poller = DeploymentJobPoller(client, "deployment-1", request_timeout_seconds=0.025)
        expect_error(RequestDeadlineExceeded, lambda: poller.next_job(timeout=20))
        assert started.is_set()
        assert poller._pending is None
        release.set()
        time.sleep(0.03)
        assert len(requests) == 1, "Late discovery initiated a claim"
        mode = "claim"
        attempts = 0
        release.clear()
        started.clear()
        requests.clear()
        expect_error(RequestDeadlineExceeded, lambda: poller.next_job(timeout=20))
        pending = poller._pending
        assert started.is_set() and pending is not None
        expect_error(ApiException, lambda: poller.next_job(timeout=0))
        assert poller._pending is pending
        release.set()
        assert committed.wait(timeout=1)
        result = poller.next_job(timeout=0)
        assert result is not None and result.execution_id == pending.execution_id
        assert len([request for request in requests if request.method == "GET"]) == 1
        assert poller._pending is None
    finally:
        release.set()
        run_sync(client.close())


def qualify_serialization_and_lifecycle() -> None:
    started = threading.Event()
    release = threading.Event()
    candidate_requests = 0
    wait_windows: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal candidate_requests
        if request.url.path.endswith("candidate"):
            candidate_requests += 1
            wait_windows.append(int(request.url.params["waitMs"]))
            started.set()
            while not release.is_set():
                await asyncio.sleep(0.005)
            return httpx.Response(204)
        if request.url.path.endswith("cancellation"):
            return httpx.Response(200, json={"cancelled": True})
        return httpx.Response(204)

    with tempfile.TemporaryDirectory() as directory:
        token_file = Path(directory) / "token"
        token_file.write_text("token", encoding="utf8")
        with DeploymentContext(api_url="https://api.example.test", deployment_id="deployment-1", token_file=token_file) as deployment:
            deployment._client.rest_client.pool_manager = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(deployment.next_job)
                assert started.wait(timeout=1)
                # A second caller's budget includes waiting for the first caller.
                request_deadline = time.monotonic() + 0.03
                expect_error(RequestDeadlineExceeded, lambda: deployment._jobs._next_job(0, request_deadline, request_deadline))
                assert deployment._jobs._pending is None
                execution = SelectedJob(jobId="running-job", executionId=UUID("00000000-0000-4000-8000-000000000001"))
                assert deployment.cancellation_requested(execution)
                deployment.outcome(execution, "completed")
                deployment.cleanup(execution)
                assert not first.done()
                release.set()
                assert first.result(timeout=1) is None
                assert candidate_requests == 1
                assert 0 < wait_windows[0] <= 20000

            assert deployment.next_job(timeout=0) is None
            assert wait_windows[-1] == 0
            assert candidate_requests == 2

            # The public deadline starts before token refresh, and late token
            # reads cannot create an HTTP operation after the budget is spent.
            deployment._jobs._request_timeout_seconds = 0.01
            def slow_token() -> None:
                time.sleep(0.02)
            with patch.object(deployment, "_refresh_token", slow_token):
                expect_error(RequestDeadlineExceeded, deployment.next_job)
            assert candidate_requests == 2


def qualify_restart_ride_out() -> None:
    """An API upgrade's 502/503/504s and lost connections are retried; one claim per Job."""
    restarting = httpx.Response(503, headers={"Retry-After": "1"}, json={
        "defined": True, "code": "API_RESTARTING", "status": 503, "message": "API server is restarting",
    })
    outages = {
        # A Job poll stranded at the edge while no Pod answers (run 37750459341).
        "candidate": [restarting, httpx.ConnectError("refused"), "hang"],
        "claim": [httpx.RemoteProtocolError("response lost"), httpx.Response(502), restarting],
        "cancellation": [httpx.Response(504)],
        "outcome": [restarting],
        "cleanup": [httpx.ReadError("reset")],
    }
    requests: list[httpx.Request] = []
    hung: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        operation = request.url.path.split("/")[-1]
        if outages.get(operation):
            outage = outages[operation].pop(0)
            if outage == "hang":
                hung.append(operation)
                await asyncio.sleep(5)
            if isinstance(outage, Exception):
                raise outage
            return outage
        if operation == "candidate":
            return candidate()
        if operation == "claim":
            return selected(request)
        if operation == "cancellation":
            return httpx.Response(200, json={"cancelled": False})
        if operation == "outcome" and outages.get("rejected"):
            return conflict()
        return httpx.Response(204)

    with tempfile.TemporaryDirectory() as directory, patch.object(deployments.time, "sleep") as sleep:
        token_file = Path(directory) / "token"
        token_file.write_text("token", encoding="utf8")
        with DeploymentContext(api_url="https://api.example.test", deployment_id="deployment-1", token_file=token_file) as deployment:
            deployment._client.rest_client.pool_manager = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            deployment._jobs._request_timeout_seconds = 0.5
            job = deployment.next_job(timeout=0)
            deployment._jobs._request_timeout_seconds = 30.0
            assert job is not None and job.id == "job-1"
            assert hung == ["candidate"]
            assert not job.cancellation_requested()
            job.complete()
            job.cleanup()
            assert all(not queued for queued in outages.values())
            claims = {r.headers["Idempotency-Key"] for r in requests if r.url.path.endswith("claim")}
            assert claims == {str(job.selected.execution_id)}
            assert [r.url.path.split("/")[-1] for r in requests].count("claim") == 4
            assert [call.args[0] for call in sleep.call_args_list] == [0.5, 1.0, 2.0, 4.0, 5.0, 5.0, 0.5, 0.5, 0.5]

            # Anything but a restart propagates at once, as does a restart past the budget.
            outages["rejected"] = [True]
            expect_error(ApiException, job.complete)
            outages["outcome"] = [restarting]
            with patch.object(deployments, "_RESTART_BUDGET_SECONDS", 0):
                error = expect_error(ApiException, job.complete)
            assert error.status == 503
            # A budget spent before the request went out is not a restart.
            def slow_token() -> None:
                started = time.monotonic()
                while time.monotonic() - started < 0.02:
                    pass
            deployment._timeout_seconds = 0.01
            with patch.object(deployment, "_refresh_token", slow_token):
                expect_error(RequestDeadlineExceeded, job.cancellation_requested)
            deployment._timeout_seconds = 30.0
            assert sleep.call_count == 9


def qualify_inputs() -> None:
    client = client_for(lambda _: httpx.Response(204))
    try:
        poller = DeploymentJobPoller(client, "deployment-1")
        for timeout in (-1, 20.01, float("inf"), float("nan")):
            expect_error(ValueError, lambda: poller.next_job(timeout=timeout))
        for timeout in (0, -1, float("inf"), float("nan")):
            expect_error(ValueError, lambda: DeploymentJobPoller(client, "deployment-1", request_timeout_seconds=timeout))
        assert DeploymentJobPoller(client, "deployment-1", request_timeout_seconds=60)._request_timeout_seconds == 30
    finally:
        run_sync(client.close())


def main() -> None:
    qualify_exact_recovery()
    qualify_conclusive_and_empty()
    qualify_unrecognized_claim_errors()
    qualify_late_discovery_and_shared_budget()
    qualify_cancellation_ordering()
    qualify_serialization_and_lifecycle()
    qualify_restart_ride_out()
    qualify_inputs()


if __name__ == "__main__":
    main()
