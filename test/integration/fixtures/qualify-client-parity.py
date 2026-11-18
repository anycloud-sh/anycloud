"""Qualify paired public convenience workflows through generated Python APIs."""

from __future__ import annotations

import asyncio
import inspect
import io
import json
import os
from pathlib import Path
import runpy
import signal
import sys
import tempfile
import typing
import unittest
from contextlib import asynccontextmanager, redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import anycloud
import httpx
import anycloud_workflows.workloads as workloads
from anycloud import AsyncClient, Client
from anycloud.exceptions import ApiException
from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.docker_options import DockerOptions
from anycloud.models.list_deployments_response import ListDeploymentsResponse
from anycloud.models.deployment_response import DeploymentResponse
from anycloud.models.deployment_summary import DeploymentSummary
from anycloud_workflows import (
    AsyncJob,
    WorkloadWaitTimeout,
    Job,
    JobFailedError,
    async_wait_for_terminal_workload,
    wait_for_terminal_workload,
)


CLIENTS = ((Client, Job), (AsyncClient, AsyncJob))


def status_body(state="running", *, kind="job", deployment=None, job_id="image-job"):
    return {
        "workload": {
            **dict.fromkeys((
                "agent", "availabilityZone", "awaitingReleaseMs", "checkpointBucket",
                "checkpointStorageRegion", "claimDeadlineAt", "cloudProvider", "command",
                "completedAt", "costSource", "diskIops", "diskSizeGb", "diskThroughputMibps", "diskTier", "dnsRecordId", "regions",
                "dockerOptions", "gpuType", "imageDigest", "inputBucket", "inputStorageRegion",
                "outputBucket", "outputStorageRegion", "publicEndpoint", "region", "secretNames", "session",
                "sessionLabel", "totalCost", "version", "vmDurationMs", "vmType", "endReason",
                "lastAttemptEndReason",
            )),
            "id": job_id,
            "image": "trainer:v1",
            "workloadType": kind,
            "deploymentId": deployment,
            "submissionRevision": 0,
            "claimed": deployment is not None,
            "userId": "user-1",
            "spot": False,
            "state": state,
            "startedAt": 0,
            "dockerCommand": "",
            "vmCount": 0,
        },
        "events": [],
        "status": "-",
        "jobsAhead": None,
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
    async def test_readiness_configuration_and_nullable_status_wire(self):
        fixture = runpy.run_path(str(Path(__file__).with_name("qualify-python-sdk-extensions.py")))
        summary = fixture["deployment_summary_body"]()
        probe = {"exec": {"command": ["test", "-f", "/ready"]}, "periodSeconds": 1}
        for client_type, _ in CLIENTS:
            requests = []

            async def handler(request):
                requests.append(request)
                if request.method == "GET" and request.url.path == "/v1/deployments":
                    return httpx.Response(200, json={"deployments": [summary]})
                body = {**summary, "readinessProbe": probe}
                if request.method == "GET":
                    body["status"] = {
                        "state": "running", "releasing": False, "ready": False, "upgrade": {"number": 1, "state": "starting"},
                        "reason": "Waiting for cleanup",
                        "requestedGeneration": 2, "appliedGeneration": None, "podGeneration": None,
                        "podName": None, "podUid": None, "containerId": None,
                        "containerReady": None, "readyReplicas": None, "applicationReady": None, "probeConfigured": None,
                        "observation": "unavailable", "observedAt": None, "observationError": "offline",
                        "blockingJobs": {"total": 12, "jobs": [{
                            "id": "blocker", "executionId": "execution", "generation": 1, "state": "terminated"
                        }]},
                    }
                return httpx.Response(200 if request.method == "GET" else 202, json={"deployment": body})

            async with client_for(client_type, handler) as client:
                created = await call(client.create_deployment, "worker", "image:v1", node_pool="training",
                    readiness_probe={"exec": {"command": ["test", "-f", "/ready"]}, "period_seconds": 1})
                self.assertEqual(created.readiness_probe.to_dict(), probe)
                await call(client.update_deployment, "worker", readiness_probe=created.readiness_probe)
                await call(client.update_deployment, "worker", readiness_probe=None)
                await call(client.update_deployment, "worker", image="image:v2")
                listed = await call(client.list_deployments)
                self.assertIsNone(listed[0].status)
                self.assertEqual(len(requests), 5)
                status = (await call(client.get_deployment, "worker")).status
                self.assertEqual(status.state, "running")
                self.assertEqual(status.upgrade.state, "starting")
                self.assertIsNone(status.application_ready)
                self.assertEqual(status.blocking_jobs.total, 12)
                self.assertEqual(status.blocking_jobs.jobs[0].id, "blocker")
            bodies = [json.loads(request.content) for request in requests[:4]]
            self.assertEqual(bodies[0]["readinessProbe"], probe)
            self.assertEqual(bodies[1:], [
                {"readinessProbe": probe}, {"readinessProbe": None}, {"image": "image:v2"},
            ])

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
                    for handle in (job, attached):
                        with self.assertRaisesRegex(ValueError, "Deployment-targeted"):
                            await call(handle.wait_for_claim)
                        with self.assertRaisesRegex(ValueError, "Deployment-targeted"):
                            await call(handle.resubmit, wait=True)
                    self.assertEqual((await call(attached.terminate)).message, "Termination scheduled")
                    response = await call(attached.resubmit)
                    self.assertIsInstance(response, WorkloadResubmitResponse)
                    self.assertIsNone(response.submission_revision)
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
            for deployment in (None, "deployment-1"):
                for state in ("errored", "failed", "invalid", "terminated"):
                    async def handler(_request):
                        return httpx.Response(200, json=status_body(state, deployment=deployment))

                    with self.subTest(client=client_type.__name__, deployment=deployment, state=state):
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
        deployment = DeploymentSummary.model_construct(id="deployment-1", name="deployment")
        response = DeploymentResponse(deployment=deployment)
        listed = ListDeploymentsResponse(deployments=[deployment])
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
                for name, args, kwargs in (
                    ("create_deployment", ("deployment", "trainer:v1"), {"node_pool": "node-pool-1"}),
                    ("get_deployment", ("deployment",), {}),
                    ("update_deployment", ("deployment",), {"command": None}),
                    ("delete_deployment", ("deployment",), {}),
                ):
                    with patch.object(client._deployments, name + suffix, return_value=response):
                        self.assertIs(await call(getattr(client, name), *args, **kwargs), deployment)
                with patch.object(client._deployments, "list_deployments" + suffix, return_value=listed):
                    self.assertIs(await call(client.list_deployments), listed.deployments)

    async def test_invalid_inputs_and_closed_clients_make_no_requests(self):
        async def handler(_request):
            self.fail("Invalid input must not reach HTTP")

        for client_type, job_type in CLIENTS:
            async with client_for(client_type, handler) as client:
                invalid = [
                    {}, {"image": "trainer:v1", "deployment": "deployment"},
                    {"deployment": " "}, {"image": "trainer:v1", "timeout": 1},
                    {"image": "trainer:v1", "wait": True},
                    {"image": "trainer:v1", "command": "python train.py"},
                    {"image": "trainer:v1", "secrets": "wandb"},
                ]
                invalid.extend({"deployment": "deployment", name: value} for name, value in (
                    ("cloud_config", {}), ("credential_name", "credential"), ("gpu", []),
                    ("env", {}), ("secrets", []), ("docker_options", {}), ("command", []),
                ))
                for arguments in invalid:
                    with self.subTest(client=client_type.__name__, arguments=arguments):
                        with self.assertRaises((ValueError, TypeError)):
                            await call(client.submit, **arguments)
                for arguments in ({}, {"image": None}, {"max_concurrent_jobs_per_replica": None}, {"docker_options": {}}, {"command": "python"}):
                    with self.assertRaises((ValueError, TypeError)):
                        await call(client.update_deployment, "deployment", **arguments)
                for operation in (client.get, client.get_deployment, client.delete_deployment):
                    with self.assertRaises(ValueError):
                        await call(operation, " ")
                job = job_type(client, "image-job")
                for arguments in ({"timeout_seconds": 0}, {"poll_interval_seconds": 0}):
                    with self.assertRaises(ValueError):
                        await call(job.wait, **arguments)
            for operation, args in (
                (client.submit, ("trainer:v1",)), (client.list_deployments, ()),
                (client.create_deployment, ("deployment", "trainer:v1")),
                (client.get, ("image-job",)), (client.get_deployment, ("deployment",)),
                (client.update_deployment, ("deployment",)), (client.delete_deployment, ("deployment",)),
                (job.status, ()), (job.wait, ()), (job.wait_for_claim, ()),
                (job.terminate, ()), (job.resubmit, ()),
            ):
                with self.assertRaisesRegex(RuntimeError, "Client is closed"):
                    await call(operation, *args, **({"node_pool": "pool"} if operation == client.create_deployment else {}))
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
                        (client.submit, ("trainer:v1",)), (client.list_deployments, ()),
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
    async def test_image_workflows_and_management_share_the_callers_loop(self):
        loop = asyncio.get_running_loop()
        waiting = set()
        listed = asyncio.Event()
        admissions = []

        async def handler(request):
            self.assertIs(asyncio.get_running_loop(), loop)
            if request.method == "POST":
                job_id = json.loads(request.content)["id"]
                admissions.append(job_id)
                return httpx.Response(202, json={"id": job_id})
            if request.url.path == "/v1/deployments":
                listed.set()
                return httpx.Response(200, json={"deployments": []})
            job_id = request.url.path.split("/")[-1]
            first = job_id not in waiting
            waiting.add(job_id)
            if not first:
                self.assertTrue(listed.is_set(), "Completion polling blocked peer management")
            return httpx.Response(200, json=status_body("running" if first else "completed", job_id=job_id))

        async with client_for(AsyncClient, handler) as client:
            async def workflow(job_id):
                job = await client.submit("trainer:v1", workload_id=job_id)
                return await job.wait(timeout_seconds=5, poll_interval_seconds=0.001)

            first, second, deployments = await asyncio.wait_for(asyncio.gather(
                workflow("first-image"), workflow("second-image"), client.list_deployments()
            ), timeout=5)
            self.assertEqual({first.id, second.id}, {"first-image", "second-image"})
            self.assertEqual(sorted(admissions), ["first-image", "second-image"])
            self.assertEqual(waiting, set(admissions))
            self.assertEqual(deployments, [])

    async def test_cancellation_during_image_admission_or_completion_keeps_client_usable(self):
        for during_admission in (True, False):
            entered = asyncio.Event()
            cancelled = asyncio.Event()
            requests = []

            async def handler(request):
                requests.append(request)
                if request.url.path == "/v1/deployments":
                    return httpx.Response(200, json={"deployments": []})
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
                self.assertEqual(await client.list_deployments(), [])
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


class KubernetesDriverTests(unittest.IsolatedAsyncioTestCase):
    def driver_path(self):
        return (
            Path(__file__).resolve().parents[1]
            / "e2e/internal/fixtures/python-sdk-driver.py"
        )

    def driver(self, name="run"):
        return runpy.run_path(str(self.driver_path()))[name]

    async def test_concurrent_driver_requests_share_one_client(self):
        admissions = []
        both_admitted = asyncio.Event()
        initial_tasks = asyncio.all_tasks()

        async def handler(request):
            if request.url.path == "/v1/workloads":
                identifier = json.loads(request.content)["id"]
                admissions.append(identifier)
                if len(admissions) == 2:
                    both_admitted.set()
                await both_admitted.wait()
                return httpx.Response(202, json={
                    "id": identifier, "submissionRevision": 0,
                    "claimDeadlineAt": 1234,
                })
            if request.url.path.endswith("/claim-observation"):
                return httpx.Response(200, json={
                    "outcome": "claimed", "claimed": True,
                    "submissionRevision": 0, "claimDeadlineAt": 1234,
                })
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.path.rsplit("/", 1)[0], "/v1/workloads")
            return httpx.Response(200, json=status_body(
                deployment="deployment-1", job_id=request.url.path.split("/")[-1]
            ))

        async with client_for(AsyncClient, handler) as client:
            try:
                result = await asyncio.wait_for(self.driver()({
                    "action": "submit_concurrent", "deployment": "deployment-1",
                    "workloadIds": ["concurrent-a", "concurrent-b"],
                    "timeout": 5, "wait": True,
                }, client), timeout=2)
            except asyncio.TimeoutError:
                self.fail("concurrent driver did not reach the two-admission barrier")
            self.assertCountEqual(admissions, ["concurrent-a", "concurrent-b"])
            self.assertEqual(
                [job["id"] for job in result["jobs"]],
                ["concurrent-a", "concurrent-b"],
            )
            self.assertTrue(all(job["claimed"] for job in result["jobs"]))
        self.assertEqual(asyncio.all_tasks(), initial_tasks)

    async def test_failed_batch_cancels_and_joins_its_waiting_sibling(self):
        waiting = asyncio.Event()
        cancelled = asyncio.Event()
        initial_tasks = asyncio.all_tasks()

        async def handler(request):
            if request.url.path == "/v1/workloads":
                identifier = json.loads(request.content)["id"]
                if identifier == "rejected-job":
                    await waiting.wait()
                    return httpx.Response(400, json={"message": "rejected submission"})
                return httpx.Response(202, json={
                    "id": identifier, "submissionRevision": 0,
                    "claimDeadlineAt": 1234,
                })
            self.assertTrue(request.url.path.endswith("/claim-observation"))
            waiting.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                cancelled.set()

        async with client_for(AsyncClient, handler) as client:
            with self.assertRaises(ApiException) as caught:
                await asyncio.wait_for(self.driver()({
                    "action": "submit_concurrent", "deployment": "deployment-1",
                    "workloadIds": ["waiting-job", "rejected-job"],
                    "timeout": 5, "wait": True,
                }, client), timeout=2)
            self.assertEqual(caught.exception.status, 400)
            self.assertTrue(cancelled.is_set())
            self.assertEqual(asyncio.all_tasks(), initial_tasks)
        self.assertEqual(asyncio.all_tasks(), initial_tasks)

    async def test_parent_cancellation_and_timeout_join_both_requests(self):
        for mode in ("cancel", "timeout"):
            with self.subTest(mode=mode):
                entered = set()
                finished = set()
                both_entered = asyncio.Event()
                initial_tasks = asyncio.all_tasks()

                async def handler(request):
                    self.assertEqual(request.url.path, "/v1/workloads")
                    identifier = json.loads(request.content)["id"]
                    entered.add(identifier)
                    if len(entered) == 2:
                        both_entered.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        finished.add(identifier)

                async with client_for(AsyncClient, handler) as client:
                    batch = asyncio.create_task(self.driver()({
                        "action": "submit_concurrent", "deployment": "deployment-1",
                        "workloadIds": ["waiting-a", "waiting-b"], "wait": True,
                    }, client))
                    try:
                        await asyncio.wait_for(both_entered.wait(), timeout=2)
                        if mode == "cancel":
                            batch.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await batch
                        else:
                            with self.assertRaises(asyncio.TimeoutError):
                                await asyncio.wait_for(batch, timeout=0.001)
                        self.assertEqual(finished, {"waiting-a", "waiting-b"})
                        self.assertEqual(asyncio.all_tasks(), initial_tasks)
                        self.assertFalse(client.api_client.rest_client.pool_manager.is_closed)
                    finally:
                        batch.cancel()
                        await asyncio.gather(batch, return_exceptions=True)

    async def test_main_emits_success_only_after_its_own_client_closes(self):
        async def handler(request):
            if request.method == "POST":
                return httpx.Response(202, json={
                    "id": json.loads(request.content)["id"],
                    "submissionRevision": 0, "claimDeadlineAt": 1234,
                })
            return httpx.Response(200, json=status_body(
                deployment="deployment-1", job_id=request.url.path.split("/")[-1],
            ))

        client = AsyncClient(api_url="https://api.example.test", token="test-token")
        transport = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client.api_client.rest_client.pool_manager = transport
        main = self.driver("main")
        output, diagnostics = io.StringIO(), io.StringIO()
        request = {"action": "submit_concurrent", "deployment": "deployment-1",
                   "workloadIds": ["main-a", "main-b"]}
        try:
            with patch.dict(main.__globals__, {"AsyncClient": lambda: client}), \
                    patch("sys.stdin", io.StringIO(json.dumps(request))), \
                    redirect_stdout(output), redirect_stderr(diagnostics):
                await main()
            result = json.loads(output.getvalue())
            self.assertTrue(transport.is_closed)
            self.assertEqual(result["client"], "AsyncClient")
            self.assertIs(result["transportClosed"], True)
            self.assertEqual(result["pendingTasks"], 0)
            self.assertEqual([job["id"] for job in result["jobs"]], ["main-a", "main-b"])
            self.assertEqual(diagnostics.getvalue(), "")
        finally:
            await transport.aclose()

    async def test_main_preserves_action_and_close_failures_with_observed_cleanup(self):
        for mode in ("action", "close", "incomplete-close", "action-and-close"):
            with self.subTest(mode=mode):
                client = AsyncClient(api_url="https://api.example.test", token="test-token")
                transport = httpx.AsyncClient(transport=httpx.MockTransport(
                    lambda _: httpx.Response(200, json=status_body(deployment="deployment-1"))
                ))
                client.api_client.rest_client.pool_manager = transport
                main = self.driver("main")
                action_error = ValueError("original action failure")
                close_error = RuntimeError("original close failure")
                action = AsyncMock(
                    side_effect=action_error if mode in ("action", "action-and-close") else None,
                    return_value={"jobs": []},
                )
                real_close = client.aclose
                if mode in ("close", "action-and-close"):
                    client.aclose = AsyncMock(side_effect=close_error)
                elif mode == "incomplete-close":
                    client.aclose = AsyncMock()
                output, diagnostics = io.StringIO(), io.StringIO()
                try:
                    with patch.dict(main.__globals__, {"AsyncClient": lambda: client, "run": action}), \
                            patch("sys.stdin", io.StringIO('{"action":"submit_concurrent"}')), \
                            redirect_stdout(output), redirect_stderr(diagnostics):
                        with self.assertRaises((ValueError, RuntimeError, AssertionError)) as caught:
                            await main()
                    self.assertEqual(output.getvalue(), "")
                    observation = json.loads(diagnostics.getvalue())
                    self.assertEqual(observation["kind"], "python-sdk-finalization")
                    self.assertEqual(observation["pendingTasks"], 0)
                    self.assertIs(observation["transportClosed"], mode == "action")
                    if mode in ("action", "action-and-close"):
                        self.assertIs(caught.exception, action_error)
                    if mode == "close":
                        self.assertIs(caught.exception, close_error)
                    if mode == "action-and-close":
                        self.assertIs(caught.exception.__cause__, close_error)
                finally:
                    client.aclose = real_close
                    await client.aclose()
                    await transport.aclose()

    async def test_sigterm_cancels_the_real_driver_and_retains_failure_diagnostics(self):
        both_entered = asyncio.Event()
        entered = set()
        handlers = set()

        async def handler(reader, writer):
            task = asyncio.current_task()
            handlers.add(task)
            try:
                headers = (await reader.readuntil(b"\r\n\r\n")).decode()
                length = next(int(line.split(":", 1)[1]) for line in headers.splitlines()
                              if line.lower().startswith("content-length:"))
                entered.add(json.loads(await reader.readexactly(length))["id"])
                if len(entered) == 2:
                    both_entered.set()
                await reader.read()
            finally:
                writer.close()
                await writer.wait_closed()
                handlers.discard(task)

        server = await asyncio.start_server(handler, "127.0.0.1", 0)
        process = None
        try:
            with tempfile.TemporaryDirectory(prefix="anycloud-driver-signal-") as directory:
                # A loopback API takes the token `anycloud api start` writes.
                Path(directory, "local-api-token").write_text("test-token")
                environment = {
                    **os.environ, "ANYCLOUD_DIR": directory, "GITHUB_TOKEN": "test-token",
                    "API_URL": f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}",
                }
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-I", str(self.driver_path()),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, env=environment,
                )
                process.stdin.write(json.dumps({
                    "action": "submit_concurrent", "deployment": "deployment-1",
                    "workloadIds": ["signal-a", "signal-b"], "wait": True,
                }).encode())
                await process.stdin.drain()
                process.stdin.close()
                await asyncio.wait_for(both_entered.wait(), timeout=5)
                process.send_signal(signal.SIGTERM)
                output, diagnostics = await asyncio.wait_for(process.communicate(), timeout=2)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(output, b"")
                record = next(json.loads(line) for line in diagnostics.decode().splitlines()
                              if line.startswith('{"kind":"python-sdk-finalization"'))
                self.assertIs(record["transportClosed"], True)
                self.assertEqual(record["pendingTasks"], 0)
                self.assertEqual(record["errors"], [{"phase": "action", "type": "CancelledError"}])
                await asyncio.wait_for(asyncio.gather(*handlers), timeout=2)
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.communicate()
            server.close()
            await server.wait_closed()
            for task in list(handlers):
                task.cancel()
            await asyncio.gather(*handlers, return_exceptions=True)

    async def test_main_reports_an_unjoined_task_as_incomplete(self):
        client = AsyncClient(api_url="https://api.example.test", token="test-token")
        transport = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        client.api_client.rest_client.pool_manager = transport
        main = self.driver("main")
        pending = None

        async def unjoined_action(*_args):
            nonlocal pending
            pending = asyncio.create_task(asyncio.Event().wait(), name="unjoined-request")
            return {"jobs": []}

        output, diagnostics = io.StringIO(), io.StringIO()
        try:
            with patch.dict(main.__globals__, {"AsyncClient": lambda: client, "run": unjoined_action}), \
                    patch("sys.stdin", io.StringIO('{"action":"submit_concurrent"}')), \
                    redirect_stdout(output), redirect_stderr(diagnostics):
                with self.assertRaisesRegex(AssertionError, "left pending tasks"):
                    await main()
            record = json.loads(diagnostics.getvalue())
            self.assertIs(record["transportClosed"], True)
            self.assertEqual(record["pendingTasks"], 1)
            self.assertEqual(output.getvalue(), "")
        finally:
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            await transport.aclose()


if __name__ == "__main__":
    suite = unittest.TestSuite(
        unittest.defaultTestLoader.loadTestsFromTestCase(case)
        for case in (ClientParityTests, NativeAsyncLifecycleTests, KubernetesDriverTests)
    )
    if not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful():
        raise SystemExit(1)
