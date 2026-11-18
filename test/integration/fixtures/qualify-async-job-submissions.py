"""Async customer workflows through the generated HTTP transport."""

from __future__ import annotations

import asyncio
from collections import Counter
from contextlib import asynccontextmanager
import json
import unittest

import anycloud
import httpx
from anycloud import AsyncClient
from anycloud.exceptions import ApiException
from anycloud_workflows import (
    AsyncJob,
    JobSubmissionChanged,
    JobSubmissionExpired,
    JobSubmissionTerminated,
    JobSubmissionUncertain,
)
from anycloud_workflows._request_deadline import RequestDeadlineExceeded


def receipt(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        202,
        json={
            "id": json.loads(request.content)["id"],
            "submissionRevision": 0,
            "claimDeadlineAt": 1234,
        },
    )


def observation(outcome="claimed", revision=0, claimed=None) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "submissionRevision": revision,
            "claimDeadlineAt": 1234,
            "claimed": outcome == "claimed" if claimed is None else claimed,
            "outcome": outcome,
        },
    )


@asynccontextmanager
async def client_for(handler, timeout=1):
    async with AsyncClient(
        api_url="https://api.example.test",
        token="test-token",
        request_timeout_seconds=timeout,
    ) as client:
        pool = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client.api_client.rest_client.pool_manager = pool
        yield client
    assert pool.is_closed
    await client.aclose()


class AsyncSubmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_handlers_keep_one_submission_each(self):
        loop = asyncio.get_running_loop()
        admissions = []
        observations = Counter()
        both_waiting = asyncio.Event()

        async def handler(request):
            self.assertIs(asyncio.get_running_loop(), loop)
            self.assertEqual(
                request.headers["AnyCloud-Client-Version"], anycloud.__version__
            )
            self.assertEqual(request.headers["Authorization"], "Bearer test-token")
            body = json.loads(request.content)
            if request.url.path == "/v1/workloads":
                admissions.append(body["id"])
                self.assertEqual(body["deployment"], "deployment-1")
                self.assertEqual(body["timeout"], 5)
                return receipt(request)
            self.assertTrue(request.url.path.endswith("/claim-observation"))
            self.assertEqual(body["submissionRevision"], 0)
            self.assertLessEqual(body["waitMs"], 750)
            job_id = request.url.path.split("/")[-2]
            observations[job_id] += 1
            if len(observations) == 2:
                both_waiting.set()
            await both_waiting.wait()
            return observation("pending" if observations[job_id] == 1 else "claimed")

        async with client_for(handler) as client:
            jobs = await asyncio.wait_for(
                asyncio.gather(
                    client.submit(deployment="deployment-1", timeout=5, wait=True),
                    client.submit(deployment="deployment-1", timeout=5, wait=True),
                ),
                timeout=2,
            )
            self.assertEqual(len(set(admissions)), 2)
            self.assertEqual(Counter(admissions), Counter({job.id: 1 for job in jobs}))
            self.assertEqual(observations, Counter({job.id: 2 for job in jobs}))
            for job in jobs:
                self.assertIsInstance(job, AsyncJob)
                self.assertEqual(job.submission.id, job.id)
                self.assertRegex(job.id, r"^job-[a-f0-9]{24}$")

    async def test_confirmed_outcomes_retain_the_async_handle(self):
        for outcome, revision, expected in (
            ("expired", 0, JobSubmissionExpired),
            ("terminated", 0, JobSubmissionTerminated),
            ("changed", 1, JobSubmissionChanged),
        ):

            async def handler(request):
                return (
                    receipt(request)
                    if request.url.path == "/v1/workloads"
                    else observation(outcome, revision)
                )

            async with client_for(handler) as client:
                with self.assertRaises(expected) as caught:
                    await client.submit(deployment="deployment-1", timeout=0, wait=True)
                error = caught.exception
                self.assertIsInstance(error.job, AsyncJob)
                self.assertEqual(error.workload_id, error.job.id)
                self.assertEqual(error.revision, 0)
                self.assertEqual(error.job.submission.submission_revision, 0)

    async def test_inconsistent_observation_is_uncertain(self):
        for revision, claimed in ((1, True), (0, False)):

            async def handler(request):
                return (
                    receipt(request)
                    if request.url.path == "/v1/workloads"
                    else observation("claimed", revision, claimed)
                )

            async with client_for(handler) as client:
                with self.assertRaises(JobSubmissionUncertain) as caught:
                    await client.submit(deployment="deployment-1", wait=True)
                self.assertIsInstance(caught.exception.cause, ValueError)

    async def test_lost_responses_recover_by_observation_without_resubmission(self):
        for lose_admission in (True, False):
            original = httpx.ReadTimeout("response lost")
            admissions = []
            lost = False

            async def handler(request):
                nonlocal lost
                admitting = request.url.path == "/v1/workloads"
                if admitting:
                    admissions.append(json.loads(request.content)["id"])
                if not lost and admitting == lose_admission:
                    lost = True
                    raise original
                return receipt(request) if admitting else observation()

            async with client_for(handler) as client:
                with self.assertRaises(JobSubmissionUncertain) as caught:
                    await client.submit(deployment="deployment-1", wait=True)
                error = caught.exception
                self.assertIs(error.cause, original)
                self.assertIs(error.__cause__, original)
                self.assertEqual(error.job.submission is None, lose_admission)
                self.assertIs(await error.job.wait_for_claim(), error.job)
                self.assertEqual(admissions, [error.job.id])

    async def test_admission_rejection_and_observation_errors_stay_distinct(self):
        for status, admitting in (
            (400, True),
            (401, True),
            (429, True),
            (408, True),
            (503, True),
            (404, False),
        ):

            async def handler(request):
                if request.url.path == "/v1/workloads" and not admitting:
                    return receipt(request)
                return httpx.Response(status, json={"error": "request failed"})

            expected = (
                ApiException
                if admitting and status in (400, 401, 429)
                else JobSubmissionUncertain
            )
            async with client_for(handler) as client:
                with self.assertRaises(expected) as caught:
                    await client.submit(deployment="deployment-1", wait=True)
                error = caught.exception
                if isinstance(error, JobSubmissionUncertain):
                    self.assertEqual(error.cause.status, status)
                    self.assertIs(error.__cause__, error.cause)
                else:
                    self.assertEqual(error.status, status)

    async def test_elapsed_request_timeout_never_confirms_expiry(self):
        cancelled = asyncio.Event()

        async def handler(request):
            if request.url.path == "/v1/workloads":
                # Slow admission still has its normal budget; only observation expires.
                await asyncio.sleep(0.04)
                client._request_timeout_seconds = 0.03
                return receipt(request)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async with client_for(handler) as client:
            with self.assertRaises(JobSubmissionUncertain) as caught:
                await client.submit(deployment="deployment-1", timeout=5, wait=True)
            self.assertIsInstance(caught.exception.cause, RequestDeadlineExceeded)
            self.assertIsNotNone(caught.exception.job.submission)
            await asyncio.wait_for(cancelled.wait(), timeout=1)

    async def test_existing_handle_retains_request_error_and_can_resume_waiting(self):
        original = httpx.ReadError("observation response lost")
        observations = 0
        admissions = 0

        async def handler(request):
            nonlocal observations, admissions
            if request.url.path == "/v1/workloads":
                admissions += 1
                return receipt(request)
            observations += 1
            if observations == 1:
                raise original
            return observation()

        async with client_for(handler) as client:
            job = await client.submit(deployment="deployment-1", timeout=5)
            self.assertEqual(observations, 0)
            with self.assertRaises(httpx.ReadError) as caught:
                await job.wait_for_claim()
            self.assertIs(caught.exception, original)
            self.assertIs(await job.wait_for_claim(), job)
            self.assertEqual(admissions, 1)

    async def test_outer_timeout_preserves_asyncio_timeout_semantics(self):
        entered = asyncio.Event()
        cancelled = asyncio.Event()

        async def handler(request):
            if request.url.path == "/v1/workloads":
                return receipt(request)
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async with client_for(handler) as client:
            task = asyncio.create_task(
                client.submit(
                    deployment="deployment-1", workload_id="request-timeout", wait=True
                )
            )
            await asyncio.wait_for(entered.wait(), timeout=1)
            with self.assertRaises(asyncio.TimeoutError) as caught:
                await asyncio.wait_for(task, timeout=0.01)
            self.assertNotIsInstance(caught.exception, JobSubmissionExpired)
            self.assertTrue(task.cancelled())
            self.assertTrue(cancelled.is_set())

    async def test_cancellation_stays_cancelled_and_ignores_late_responses(self):
        for during_admission in (True, False):
            entered = asyncio.Event()
            release = asyncio.Event()
            finished = asyncio.Event()
            requests = []

            async def handler(request):
                requests.append(request)
                admitting = request.url.path == "/v1/workloads"
                if admitting == during_admission:
                    entered.set()
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        # Model a transport that finishes after cancellation.
                        await release.wait()
                    finished.set()
                return receipt(request) if admitting else observation()

            async with client_for(handler) as client:
                task = asyncio.create_task(
                    client.submit(
                        deployment="deployment-1", workload_id="request-cancelled", wait=True
                    )
                )
                await asyncio.wait_for(entered.wait(), timeout=1)
                task.cancel("request disconnected")
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(task.cancelled())
                self.assertEqual(
                    json.loads(requests[0].content)["id"], "request-cancelled"
                )
                release.set()
                await asyncio.wait_for(finished.wait(), timeout=1)
                await asyncio.sleep(0)
                self.assertEqual(len(requests), 1 if during_admission else 2)

    async def test_validation_and_closed_client_do_not_submit(self):
        async def handler(_request):
            self.fail("Invalid input must not send an HTTP request")

        async with client_for(handler) as client:
            for arguments in (
                {"deployment": " "},
                {"deployment": "deployment-1", "timeout": -1},
                {"deployment": "deployment-1", "timeout": float("inf")},
            ):
                with self.assertRaises(ValueError):
                    await client.submit(**arguments)
        with self.assertRaisesRegex(RuntimeError, "Client is closed"):
            await client.submit(deployment="deployment-1")


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=1).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(AsyncSubmissionTests)
    )
    if not result.wasSuccessful():
        raise SystemExit(1)
