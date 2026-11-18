"""Deployment submission receipts, public error semantics, and same-ID resubmission."""

from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from anycloud.exceptions import ApiException
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud_workflows import (
    Client, JobSubmissionChanged, JobSubmissionExpired,
    JobSubmissionTerminated, JobSubmissionUncertain,
)
from anycloud_workflows._request_deadline import RequestDeadlineExceeded


def expect_error(error_type: type[BaseException], operation: object) -> BaseException:
    try:
        operation()
    except error_type as error:
        return error
    raise AssertionError(f"Expected {error_type.__name__}")


def qualify_submission_receipts() -> None:
    requests: list[httpx.Request] = []
    revision = 0
    outcome = "claimed"
    claim_deadline: float | None = 1234
    change_after_resubmit = False

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal revision, claim_deadline
        requests.append(request)
        assert request.method == "POST", "Receipt observation used a racing status lookup"
        assert request.headers["AnyCloud-Client-Version"]
        body = json.loads(request.content)
        if request.url.path == "/v1/workloads":
            assert re.fullmatch(r"job-[0-9a-f]{24}", body["id"]), body
            return httpx.Response(202, json={"id": body["id"], "submissionRevision": revision, "claimDeadlineAt": claim_deadline})
        if request.url.path.endswith("resubmissions"):
            revision += 1
            claim_deadline = 2345 if "timeout" in body else None
            receipt = {"message": "Workload resubmitted", "submissionRevision": revision, "claimDeadlineAt": claim_deadline}
            if change_after_resubmit:
                revision += 1
            return httpx.Response(202, json=receipt)
        assert request.url.path.endswith("claim-observation")
        observed = "changed" if body["submissionRevision"] != revision else outcome
        return httpx.Response(200, json={
            "submissionRevision": revision, "claimDeadlineAt": claim_deadline,
            "claimed": observed == "claimed", "outcome": observed,
        })

    with Client(api_url="https://api.example.test", token="token") as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        job = client.submit(deployment="deployment-1", timeout=5, wait=True)
        identifier = job.id
        assert json.loads(requests[0].content)["timeout"] == 5
        assert len(requests) == 2
        assert job.submission.id == identifier
        assert job._submission_revision == 0
        receipt = job.resubmit(timeout=0, wait=True)
        assert isinstance(receipt, WorkloadResubmitResponse)
        assert receipt.message == "Workload resubmitted"
        assert receipt.submission_revision == 1 and receipt.claim_deadline_at == 2345
        assert job.id == identifier and job._submission_revision == 1
        assert job.submission.submission_revision == 0
        assert json.loads(requests[-2].content) == {"timeout": 0}
        receipt = job.resubmit()
        assert receipt.submission_revision == 2 and receipt.claim_deadline_at is None
        assert job._claim_deadline_at is None and job._submission_revision == 2
        assert json.loads(requests[-1].content) == {}
        assert job.wait_for_claim() is job
        for result, expected in (("expired", JobSubmissionExpired), ("terminated", JobSubmissionTerminated)):
            outcome = result
            error = expect_error(expected, job.wait_for_claim)
            assert error.job is job and error.workload_id == identifier
            assert error.revision == job._submission_revision
        outcome = "claimed"
        change_after_resubmit = True
        job.resubmit(timeout=1)
        assert job._submission_revision == revision - 1
        error = expect_error(JobSubmissionChanged, job.wait_for_claim)
        assert error.job is job and error.revision == revision - 1
        assert json.loads(requests[-1].content)["submissionRevision"] == revision - 1
        assert all(identifier in request.url.path for request in requests[1:])


def qualify_uncertain_submission_and_existing_errors() -> None:
    requests: list[httpx.Request] = []
    fail_admission = True
    mode = "claimed"
    original = httpx.ReadTimeout("response lost")

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/v1/workloads":
            if fail_admission:
                raise original
            body = json.loads(request.content)
            return httpx.Response(202, json={"id": body["id"], "submissionRevision": 0, "claimDeadlineAt": None})
        if mode == "network":
            raise original
        if mode == "api":
            return httpx.Response(503, json={"error": "temporarily unavailable"})
        if mode == "slow":
            await asyncio.sleep(1)
        return httpx.Response(200, json={"submissionRevision": 0, "claimDeadlineAt": None, "claimed": True, "outcome": "claimed"})

    with Client(api_url="https://api.example.test", token="token", request_timeout_seconds=1) as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        error = expect_error(JobSubmissionUncertain, lambda: client.submit(deployment="deployment-1", timeout=0))
        assert error.cause is original and error.__cause__ is original
        job = error.job
        assert re.fullmatch(r"job-[0-9a-f]{24}", job.id)
        assert json.loads(requests[0].content)["id"] == job.id
        assert job.submission is None and job.wait_for_claim() is job
        mode = "network"
        assert expect_error(httpx.ReadTimeout, job.wait_for_claim) is original
        assert expect_error(httpx.ReadTimeout, job.resubmit) is original
        assert job._submission_revision == 0
        mode = "api"
        expect_error(ApiException, job.wait_for_claim)
        expect_error(ApiException, job.resubmit)
        mode = "slow"
        client._request_timeout_seconds = 0.05
        expect_error(RequestDeadlineExceeded, job.wait_for_claim)
        expect_error(RequestDeadlineExceeded, job.resubmit)
        client._request_timeout_seconds = 1
        fail_admission = False
        mode = "network"
        error = expect_error(JobSubmissionUncertain, lambda: client.submit(deployment="deployment-1", wait=True))
        assert error.cause is original and error.job.submission is not None


def qualify_submission_inputs() -> None:
    with Client(api_url="https://api.example.test", token="token") as client:
        for arguments in (
            {"image": "image", "wait": True},
            {"image": "image", "timeout": 0},
            {"deployment": "deployment", "timeout": -1},
            {"deployment": "deployment", "timeout": float("inf")},
            {"deployment": "deployment", "timeout": float("nan")},
            {"deployment": "deployment", "workload_id": ""},
        ):
            expect_error(ValueError, lambda: client.submit(**arguments))


def qualify_admission_rejection_errors() -> None:
    admission_status = 400
    admission_errors: list[ApiException] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/workloads" and admission_status == 202:
            return httpx.Response(202, json={
                "id": json.loads(request.content)["id"],
                "submissionRevision": 0, "claimDeadlineAt": None,
            })
        status = admission_status if request.url.path == "/v1/workloads" else 401
        return httpx.Response(status, json={"error": "Request rejected"})

    with Client(api_url="https://api.example.test", token="token") as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        submit = client._admission.submit_workload

        async def capture_admission_error(*args: object, **kwargs: object) -> object:
            try:
                return await submit(*args, **kwargs)
            except ApiException as error:
                admission_errors.append(error)
                raise

        with patch.object(
            client._admission, "submit_workload", capture_admission_error
        ):
            for admission_status in (400, 401, 403, 404, 409, 422, 429):
                error = expect_error(
                    ApiException, lambda: client.submit(deployment="deployment-1")
                )
                assert error is admission_errors[-1]
                assert error.status == admission_status

            # An HTTP request timeout does not prove admission failed. Server
            # failures can also arrive after the submission was persisted.
            for admission_status in (408, 500, 503):
                error = expect_error(
                    JobSubmissionUncertain, lambda: client.submit(deployment="deployment-1")
                )
                assert error.cause is admission_errors[-1]
                assert error.__cause__ is error.cause
                assert error.job.submission is None

            admission_status = 202
            error = expect_error(
                JobSubmissionUncertain,
                lambda: client.submit(deployment="deployment-1", wait=True),
            )
            assert isinstance(error.cause, ApiException) and error.cause.status == 401
            assert error.job.submission is not None


def qualify_confirmed_submission_handle() -> None:
    identifier = ""
    revision = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal identifier, revision
        if request.url.path == "/v1/workloads":
            identifier = json.loads(request.content)["id"]
            return httpx.Response(202, json={
                "id": identifier, "submissionRevision": revision,
                "claimDeadlineAt": 1234,
            })
        assert identifier in request.url.path
        if request.url.path.endswith("resubmissions"):
            revision += 1
            return httpx.Response(202, json={
                "message": "Workload resubmitted", "submissionRevision": revision,
                "claimDeadlineAt": None,
            })
        return httpx.Response(200, json={
            "submissionRevision": revision,
            "claimDeadlineAt": 1234 if revision == 0 else None,
            "claimed": revision > 0, "outcome": "expired" if revision == 0 else "claimed",
        })

    with Client(api_url="https://api.example.test", token="token") as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        error = expect_error(
            JobSubmissionExpired,
            lambda: client.submit(deployment="deployment-1", timeout=0, wait=True),
        )
        assert error.workload_id == identifier and error.revision == 0
        assert error.job.id == identifier
        response = error.job.resubmit(wait=True)
        assert response.submission_revision == 1 and response.claim_deadline_at is None
        assert error.job.id == identifier and error.job._submission_revision == 1
        assert error.revision == 0, "The failure must retain the observed revision"


def qualify_resubmit_request_policy() -> None:
    for deployment in (None, "deployment-1"):
        resubmission_timeouts: list[float] = []
        identifier = "deployment-job" if deployment else "ordinary-job"
        revision = 0 if deployment else None
        stalled = False

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal revision
            if request.url.path == "/v1/workloads":
                return httpx.Response(202, json={
                    "id": identifier, "submissionRevision": revision,
                    "claimDeadlineAt": None,
                })
            assert request.url.path == f"/v1/workloads/{identifier}/resubmissions"
            resubmission_timeouts.append(request.extensions["timeout"]["read"])
            if stalled:
                await asyncio.sleep(1)
            if revision is not None:
                revision += 1
            return httpx.Response(202, json={
                "message": "Workload resubmitted", "submissionRevision": revision,
                "claimDeadlineAt": None,
            })

        with Client(
            api_url="https://api.example.test", token="token", request_timeout_seconds=90
        ) as client:
            client.api_client.rest_client.pool_manager = httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            )
            submitted = client.submit(
                image=None if deployment else "deployment:latest",
                deployment=deployment, workload_id=identifier,
            )
            observed = SimpleNamespace(workload=SimpleNamespace(
                workload_type="job", deployment_id=deployment, submission_revision=revision,
            ))
            with patch.object(client, "_status", return_value=observed):
                attached = client.get(identifier)
            for job in (submitted, attached):
                response = job.resubmit()
                assert response.message == "Workload resubmitted"
                assert response.submission_revision == revision
                assert job._submission_revision == revision
                assert job.id == identifier
            assert len(resubmission_timeouts) == 2
            assert all(89 < timeout <= 90 for timeout in resubmission_timeouts)

            stalled = True
            client._request_timeout_seconds = 0.05
            for job in (submitted, attached):
                acknowledged_revision = job._submission_revision
                expect_error(RequestDeadlineExceeded, job.resubmit)
                assert job._submission_revision == acknowledged_revision
                assert job.id == identifier
            assert all(0 < timeout <= 0.05 for timeout in resubmission_timeouts[2:])


def qualify_explicit_id_normalization() -> None:
    requests: list[httpx.Request] = []
    lose_response = False

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if lose_response:
            raise httpx.RemoteProtocolError("response lost")
        body = json.loads(request.content)
        # The API trims explicit IDs at admission. The retained local handle
        # must use that same identity, including when the response is lost.
        return httpx.Response(202, json={
            "id": body["id"].strip(), "submissionRevision": 0,
            "claimDeadlineAt": None,
        })

    with Client(api_url="https://api.example.test", token="token") as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        job = client.submit(deployment="deployment-1", workload_id=" job-1 ")
        assert job.id == "job-1" and job.submission.id == "job-1"
        assert json.loads(requests[0].content)["id"] == "job-1"

        lose_response = True
        error = expect_error(JobSubmissionUncertain, lambda: client.submit(
            deployment="deployment-1", workload_id=" job-2 "
        ))
        assert error.job.id == "job-2"


def qualify_pending_observation_windows() -> None:
    outcomes: list[str] = []
    final_outcome = "claimed"
    deadline = 0.0
    deadline_at = 0
    job_id = ""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            pass

        def do_POST(self) -> None:
            nonlocal deadline, deadline_at, job_id
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/v1/workloads":
                job_id = body["id"]
                deadline = time.monotonic() + body["timeout"]
                deadline_at = round((time.time() + body["timeout"]) * 1000)
                self.respond(202, {
                    "id": job_id, "submissionRevision": 0,
                    "claimDeadlineAt": deadline_at,
                })
                return
            assert self.path == f"/v1/workloads/{job_id}/claim-observation"
            assert body["submissionRevision"] == 0
            if final_outcome == "claimed" and len(outcomes) >= 2:
                outcome = "claimed"
            else:
                # Honor the complete requested observation window. The real
                # transport still needs time to deliver and decode this reply.
                time.sleep(min(
                    body["waitMs"] / 1000, max(0, deadline - time.monotonic())
                ))
                outcome = "expired" if time.monotonic() >= deadline else "pending"
            outcomes.append(outcome)
            self.respond(200, {
                "submissionRevision": 0, "claimDeadlineAt": deadline_at,
                "claimed": outcome == "claimed", "outcome": outcome,
            })

        def respond(self, status: int, payload: dict[str, object]) -> None:
            encoded = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with Client(
            api_url=f"http://127.0.0.1:{server.server_port}", token="token",
            request_timeout_seconds=0.6,
        ) as client:
            job = client.submit(deployment="deployment-1", timeout=5, wait=True)
            assert job.id == job_id
            assert outcomes == ["pending", "pending", "claimed"]

            outcomes.clear()
            final_outcome = "expired"
            expect_error(JobSubmissionExpired, lambda: client.submit(
                deployment="deployment-1", timeout=1.15, wait=True,
            ))
            assert len(outcomes) >= 3
            assert outcomes[-1] == "expired"
            assert all(outcome == "pending" for outcome in outcomes[:-1])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main() -> None:
    qualify_submission_receipts()
    qualify_uncertain_submission_and_existing_errors()
    qualify_submission_inputs()
    qualify_admission_rejection_errors()
    qualify_confirmed_submission_handle()
    qualify_resubmit_request_policy()
    qualify_explicit_id_normalization()
    qualify_pending_observation_windows()


if __name__ == "__main__":
    main()
