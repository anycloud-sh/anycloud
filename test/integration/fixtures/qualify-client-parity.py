"""Qualify paired public convenience workflows through generated Python APIs."""

from __future__ import annotations

import asyncio
import inspect
import json
import typing
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

import anycloud
import httpx
import anycloud_workflows.workloads as workloads
from anycloud import AsyncClient, Client
from anycloud.exceptions import ApiException
from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.docker_options import DockerOptions
from anycloud_workflows import (
    AsyncJob,
    WorkloadWaitTimeout,
    Job,
    JobFailedError,
    async_wait_for_terminal_workload,
    wait_for_terminal_workload,
)


CLIENTS = ((Client, Job), (AsyncClient, AsyncJob))


def status_body(state="running", *, kind="job", job_id="image-job"):
    return {
        "workload": {
            **dict.fromkeys((
                "agent", "availabilityZone", "awaitingReleaseMs", "checkpointBucket",
                "checkpointStorageRegion", "cloudProvider", "command",
                "completedAt", "costSource", "diskIops", "diskSizeGb", "diskThroughputMibps", "diskTier", "dnsRecordId", "regions",
                "dockerOptions", "gpuType", "imageDigest", "inputBucket", "inputStorageRegion",
                "outputBucket", "outputStorageRegion", "region", "secretNames", "session",
                "sessionLabel", "totalCost", "version", "vmDurationMs", "vmType", "endReason",
                "lastAttemptEndReason",
            )),
            "id": job_id,
            "image": "trainer:v1",
            "workloadType": kind,
            "userId": "user-1",
            "spot": False,
            "state": state,
            "startedAt": 0,
            "dockerCommand": "",
            "vmCount": 0,
        },
        "events": [],
        "status": "-",
    }


async def call(operation, *args, **kwargs):
    result = operation(*args, **kwargs)
    return await result if inspect.isawaitable(result) else result


@asynccontextmanager
async def client_for(client_type, handler):
    client = client_type(
        api_url="https://api.example.test", token="test-token", request_timeout_seconds=12
    )
    pool = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client.api_client.rest_client.pool_manager = pool
    if isinstance(client, AsyncClient):
        async with client:
            yield client
        await client.aclose()
    else:
        with client:
            yield client
        client.close()
    assert pool.is_closed


class ClientParityTests(unittest.IsolatedAsyncioTestCase):
    def test_public_signatures_and_types_stay_paired(self):
        replacements = {Client: AsyncClient, Job: AsyncJob}
        for sync_type, async_type in ((Client, AsyncClient), (Job, AsyncJob)):
            names = {
                name for name, _ in inspect.getmembers(sync_type, inspect.isfunction)
                if not name.startswith("_")
            }
            async_names = {
                name for name, _ in inspect.getmembers(async_type, inspect.isfunction)
                if not name.startswith("_")
            }
            renamed = {"close": "aclose"} if sync_type is Client else {}
            self.assertEqual({renamed.get(name, name) for name in names}, async_names)
            pairs = [(name, renamed.get(name, name)) for name in names]
            pairs.append(("__init__", "__init__"))
            if sync_type is Client:
                pairs.extend((("__enter__", "__aenter__"), ("__exit__", "__aexit__")))
            for sync_name, async_name in pairs:
                with self.subTest(owner=sync_type.__name__, method=sync_name):
                    sync_method = getattr(sync_type, sync_name)
                    async_method = getattr(async_type, async_name)
                    parameters = lambda method: [
                        (p.name, p.kind, p.default)
                        for p in inspect.signature(method).parameters.values()
                    ]
                    self.assertEqual(parameters(sync_method), parameters(async_method))
                    self.assertEqual(
                        {name: replacements.get(value, value) for name, value in typing.get_type_hints(sync_method).items()},
                        typing.get_type_hints(async_method),
                    )
                    self.assertEqual(inspect.iscoroutinefunction(async_method), sync_name != "__init__")
        self.assertEqual(
            inspect.signature(wait_for_terminal_workload),
            inspect.signature(async_wait_for_terminal_workload),
        )

    async def test_image_submission_and_complete_job_lifecycle(self):
        expected_body = {
            "image": "trainer:v1", "workloadType": "job", "id": "image-job",
            "cloudConfig": {"region": "us-east-1", "spot": True},
            "credentialName": "aws-prod", "gpuType": ["h100:8", "a100:8"],
            "env": {"EPOCHS": "10"}, "secrets": ["wandb"],
            "dockerOptions": {"shmSize": "8g"}, "command": ["python", "train.py"],
        }
        for client_type, job_type in CLIENTS:
            requests = []
            states = iter(("queued", "running"))

            async def handler(request):
                requests.append(request)
                self.assertEqual(request.headers["AnyCloud-Client-Version"], anycloud.__version__)
                self.assertEqual(request.headers["Authorization"], "Bearer test-token")
                if request.method == "GET":
                    return httpx.Response(200, json=status_body(next(states, "completed")))
                if request.url.path.endswith("/resubmissions"):
                    self.assertEqual(json.loads(request.content), {})
                    return httpx.Response(202, json={"message": "Resubmitted"})
                if request.method == "DELETE":
                    return httpx.Response(202, json={"message": "Termination scheduled"})
                body = json.loads(request.content)
                self.assertEqual(body, expected_body if "id" in body else {
                    "image": "trainer:v1", "workloadType": "job", "cloudConfig": {}
                })
                return httpx.Response(202, json={"id": body.get("id", "server-chosen-id")})

            with self.subTest(client=client_type.__name__):
                async with client_for(client_type, handler) as client:
                    job = await call(
                        client.submit, "trainer:v1", workload_id="image-job",
                        credential_name="aws-prod", gpu=("h100:8", "a100:8"),
                        cloud_config={"region": "us-east-1", "spot": True},
                        env={"EPOCHS": "10"}, secrets=("wandb",),
                        docker_options=DockerOptions(shm_size="8g"), command=("python", "train.py"),
                    )
                    self.assertIsInstance(job, job_type)
                    self.assertIsInstance(job.submission, WorkloadAdmissionResponse)
                    self.assertEqual(job.submission.id, job.id)
                    self.assertIsNone(job.last_status)
                    self.assertEqual((await call(job.status)).workload.state, "queued")
                    before_wait = len(requests)
                    self.assertIs(await call(job.wait, timeout_seconds=10, poll_interval_seconds=0.001), job)
                    wait_requests = requests[before_wait:]
                    self.assertEqual(job.last_status.workload.state, "completed")
                    attached = await call(client.get, " image-job ")
                    self.assertIsNone(attached.submission)
                    self.assertEqual(attached.last_status.workload.state, "completed")
                    self.assertEqual((await call(attached.terminate)).message, "Termination scheduled")
                    response = await call(attached.resubmit)
                    self.assertIsInstance(response, WorkloadResubmitResponse)
                    self.assertIsNone(attached.last_status)
                    self.assertEqual((await call(client.submit, "trainer:v1")).id, "server-chosen-id")
                    self.assertEqual(sum(request.method == "POST" for request in requests), 3)
                    self.assertEqual(sum(request.method == "DELETE" for request in requests), 1)
                    self.assertTrue(wait_requests)
                    for request in requests:
                        timeouts = request.extensions["timeout"].values()
                        if request in wait_requests:
                            self.assertTrue(all(0 < value <= 10 for value in timeouts))
                        elif request.url.path.endswith("/resubmissions"):
                            self.assertTrue(all(0 < value <= 12 for value in timeouts))
                        else:
                            self.assertEqual(set(timeouts), {12})

    async def test_terminal_errors_retain_the_generated_status(self):
        for client_type, job_type in CLIENTS:
            for state in ("errored", "failed", "invalid", "terminated"):
                async def handler(_request):
                    return httpx.Response(200, json=status_body(state))

                with self.subTest(client=client_type.__name__, state=state):
                    async with client_for(client_type, handler) as client:
                        job = job_type(client, "image-job")
                        with self.assertRaises(JobFailedError) as caught:
                            await call(job.wait)
                        self.assertEqual(caught.exception.workload_id, job.id)
                        self.assertEqual(caught.exception.state, state)
                        self.assertIs(caught.exception.status, job.last_status)
                        self.assertIsInstance(job.last_status, WorkloadStatusResponse)

    async def test_completion_wait_budget_and_unbounded_helper(self):
        for client_type, job_type in CLIENTS:
            now = 0.0
            timeouts = []
            state = "running"

            def sleep(seconds):
                nonlocal now
                now += seconds

            async def async_sleep(seconds):
                sleep(seconds)

            async def handler(request):
                self.assertEqual(request.method, "GET")
                timeouts.append(request.extensions["timeout"]["read"])
                return httpx.Response(200, json=status_body(state))

            with (
                self.subTest(client=client_type.__name__),
                patch.object(workloads, "time", SimpleNamespace(monotonic=lambda: now, sleep=sleep)),
                patch.object(workloads, "asyncio", SimpleNamespace(sleep=async_sleep)),
            ):
                async with client_for(client_type, handler) as client:
                    job = job_type(client, "image-job")
                    with self.assertRaisesRegex(WorkloadWaitTimeout, "image-job"):
                        await call(job.wait, timeout_seconds=5)
                    self.assertEqual(timeouts, [5, 3, 1])
                    self.assertIsNone(job.last_status)
                    state = "terminated"
                    helper = async_wait_for_terminal_workload if client_type is AsyncClient else wait_for_terminal_workload
                    terminal = await call(helper, client.api_client, job.id, client.sdk_version, timeout_seconds=None)
                    self.assertEqual(terminal.workload.state, "terminated")
                    self.assertFalse(client.api_client.rest_client.pool_manager.is_closed)

    async def test_generated_response_identity_and_handle_construction(self):
        receipt = WorkloadAdmissionResponse(id="image-job")
        for client_type, job_type in CLIENTS:
            async def handler(_request):
                self.fail("Patched generated methods must supply these responses")

            async with client_for(client_type, handler) as client:
                suffix = "" if client_type is AsyncClient else "_sync"
                with patch.object(client._admission, "submit_workload" + suffix, return_value=receipt):
                    job = await call(client.submit, "trainer:v1")
                self.assertIs(job.submission, receipt)
                self.assertIs(job_type(client, receipt).submission, receipt)
                self.assertIsNone(job_type(client, "image-job").submission)

    async def test_invalid_inputs_and_closed_clients_make_no_requests(self):
        async def handler(_request):
            self.fail("Invalid input must not reach HTTP")

        for client_type, job_type in CLIENTS:
            async with client_for(client_type, handler) as client:
                invalid = [
                    {}, {"image": "trainer:v1", "deployment": "deployment"},
                    {"image": "trainer:v1", "timeout": 1},
                    {"image": "trainer:v1", "wait": True},
                    {"image": "trainer:v1", "command": "python train.py"},
                    {"image": "trainer:v1", "secrets": "wandb"},
                ]
                for arguments in invalid:
                    with self.subTest(client=client_type.__name__, arguments=arguments):
                        with self.assertRaises((ValueError, TypeError)):
                            await call(client.submit, **arguments)
                with self.assertRaises(ValueError):
                    await call(client.get, " ")
                job = job_type(client, "image-job")
                for arguments in ({"timeout_seconds": 0}, {"poll_interval_seconds": 0}):
                    with self.assertRaises(ValueError):
                        await call(job.wait, **arguments)
            for operation, args in (
                (client.submit, ("trainer:v1",)), (client.get, ("image-job",)),
                (job.status, ()), (job.wait, ()), (job.terminate, ()), (job.resubmit, ()),
            ):
                with self.assertRaisesRegex(RuntimeError, "Client is closed"):
                    await call(operation, *args)
            with self.assertRaisesRegex(RuntimeError, "Client is closed"):
                await call(client.__aenter__ if client_type is AsyncClient else client.__enter__)

    async def test_transport_errors_remain_errors_and_never_resubmit(self):
        for client_type, job_type in CLIENTS:
            for failure in (httpx.ReadTimeout("response lost"), 503):
                requests = []

                async def handler(request):
                    requests.append(request)
                    if isinstance(failure, Exception):
                        raise failure
                    return httpx.Response(failure, json={"error": "Unavailable"})

                async with client_for(client_type, handler) as client:
                    job = job_type(client, "image-job")
                    operations = (
                        (client.submit, ("trainer:v1",)),
                        (client.get, (job.id,)), (job.status, ()), (job.wait, ()),
                        (job.terminate, ()), (job.resubmit, ()),
                    )
                    for operation, args in operations:
                        with self.assertRaises(httpx.ReadTimeout if isinstance(failure, Exception) else ApiException) as caught:
                            await call(operation, *args)
                        if isinstance(failure, Exception):
                            self.assertIs(caught.exception, failure)
                        else:
                            self.assertEqual(caught.exception.status, 503)
                    self.assertEqual(len(requests), len(operations))

    async def test_non_job_attachment_is_rejected(self):
        for client_type, _ in CLIENTS:
            for kind in ("service", "vm"):
                async def handler(_request):
                    return httpx.Response(200, json=status_body(kind=kind))

                async with client_for(client_type, handler) as client:
                    with self.assertRaisesRegex(ValueError, "only Job handles"):
                        await call(client.get, "image-job")


class NativeAsyncLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_image_workflows_share_the_callers_loop(self):
        loop = asyncio.get_running_loop()
        waiting = set()
        admissions = []

        async def handler(request):
            self.assertIs(asyncio.get_running_loop(), loop)
            if request.method == "POST":
                job_id = json.loads(request.content)["id"]
                admissions.append(job_id)
                return httpx.Response(202, json={"id": job_id})
            job_id = request.url.path.split("/")[-1]
            first = job_id not in waiting
            waiting.add(job_id)
            return httpx.Response(200, json=status_body("running" if first else "completed", job_id=job_id))

        async with client_for(AsyncClient, handler) as client:
            async def workflow(job_id):
                job = await client.submit("trainer:v1", workload_id=job_id)
                return await job.wait(timeout_seconds=5, poll_interval_seconds=0.001)

            first, second = await asyncio.wait_for(asyncio.gather(
                workflow("first-image"), workflow("second-image")
            ), timeout=5)
            self.assertEqual({first.id, second.id}, {"first-image", "second-image"})
            self.assertEqual(sorted(admissions), ["first-image", "second-image"])
            self.assertEqual(waiting, set(admissions))

    async def test_cancellation_during_image_admission_or_completion_keeps_client_usable(self):
        for during_admission in (True, False):
            entered = asyncio.Event()
            cancelled = asyncio.Event()
            requests = []

            async def handler(request):
                requests.append(request)
                if request.url.path == "/v1/workloads/usable-job":
                    return httpx.Response(200, json=status_body(job_id="usable-job"))
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

            async with client_for(AsyncClient, handler) as client:
                job = AsyncJob(client, "saved-image-id")
                operation = client.submit("trainer:v1", workload_id=job.id) if during_admission else job.wait()
                task = asyncio.create_task(operation)
                await asyncio.wait_for(entered.wait(), timeout=1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(cancelled.is_set())
                self.assertIsNone(job.last_status)
                self.assertEqual((await client.get("usable-job")).id, "usable-job")
                self.assertEqual([request.method for request in requests], ["POST" if during_admission else "GET", "GET"])

    async def test_cancellation_during_polling_sleep_stops_observation(self):
        observed = asyncio.Event()
        requests = []

        async def handler(request):
            requests.append(request)
            self.assertEqual(len(requests), 1, "Cancellation must stop further polling")
            self.assertEqual(request.method, "GET")
            observed.set()
            return httpx.Response(200, json=status_body())

        async with client_for(AsyncClient, handler) as client:
            job = AsyncJob(client, "image-job")
            task = asyncio.create_task(job.wait(poll_interval_seconds=1))
            await asyncio.wait_for(observed.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIsNone(job.last_status)
            self.assertEqual(len(requests), 1)
            self.assertFalse(client.api_client.rest_client.pool_manager.is_closed)


if __name__ == "__main__":
    suite = unittest.TestSuite(
        unittest.defaultTestLoader.loadTestsFromTestCase(case)
        for case in (ClientParityTests, NativeAsyncLifecycleTests)
    )
    if not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful():
        raise SystemExit(1)
