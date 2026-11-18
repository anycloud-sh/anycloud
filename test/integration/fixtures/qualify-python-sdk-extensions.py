"""Qualify the handwritten Python workflow extension against generated imports."""

from __future__ import annotations

import json
import inspect
import os
import runpy
import time
import warnings
import subprocess
import sys
import sysconfig
import tempfile
import textwrap
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from python_request_deadline import qualify_request_deadlines
from python_cancellation_waits import qualify_cancellation_waits, qualify_cancellation_client_cleanup
from uuid import UUID

import anycloud
import anycloud_workflows
import anycloud_workflows.workloads as workloads
import anycloud_workflows.jobs as job_workflows
import anycloud_workflows.deployments as deployments
import httpx
from anycloud.exceptions import (
    ApiException,
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
)
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_admission_input_any_of import (
    WorkloadAdmissionInputAnyOf,
)
from anycloud.models.workload_admission_input_any_of1 import (
    WorkloadAdmissionInputAnyOf1,
)
from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.workload_status_response_workload import (
    WorkloadStatusResponseWorkload,
)
from anycloud.models.docker_options import DockerOptions
from anycloud.models.message_response import MessageResponse
from anycloud.models.selected_job import SelectedJob
from anycloud.models.deployment_response import DeploymentResponse
from anycloud.models.deployment_docker_options_update import DeploymentDockerOptionsUpdate
from anycloud.models.deployment_summary import DeploymentSummary
from anycloud.models.workload_cleanup_body import WorkloadCleanupBody
from anycloud.models.workload_outcome_body import WorkloadOutcomeBody
from anycloud_workflows import (
    Client,
    CurrentJob,
    WorkloadWaitTimeout,
    Job,
    JobFailedError,
    JobSubmissionUncertain,
    DeploymentContext,
    current_deployment,
    wait_for_terminal_workload,
)


# Explicit nullable fields in the API's Deployment Job status projection.
_EMPTY_WORKLOAD_FIELDS = dict.fromkeys((
    "agent", "availabilityZone", "awaitingReleaseMs", "checkpointBucket",
    "checkpointStorageRegion", "cloudProvider", "command", "completedAt",
    "costSource", "diskIops", "diskSizeGb", "diskThroughputMibps", "diskTier", "dnsRecordId", "regions", "dockerOptions",
    "gpuType", "imageDigest", "inputBucket", "inputStorageRegion", "outputBucket",
    "outputStorageRegion", "publicEndpoint", "region", "secretNames", "session", "sessionLabel",
    "totalCost", "version", "vmDurationMs", "vmType", "endReason", "lastAttemptEndReason",
))


def status(state: str) -> SimpleNamespace:
    return SimpleNamespace(workload=SimpleNamespace(state=state))


def generated_status(
    state: str, workload_id: str = "job-1"
) -> WorkloadStatusResponse:
    workload = WorkloadStatusResponseWorkload.model_construct(
        id=workload_id,
        state=state,
        workload_type="job",
        deployment_id="deployment-1",
        submission_revision=0,
        claim_deadline_at=None,
        claimed=False,
    )
    return WorkloadStatusResponse.model_construct(
        workload=workload,
        events=[],
        status="-",
    )


def qualify_package_layout() -> None:
    package = Path(anycloud_workflows.__file__).resolve()
    if os.environ.get("ANYCLOUD_EXPECT_INSTALLED") == "1":
        assert sys.prefix != sys.base_prefix, sys.executable
        purelib = Path(sysconfig.get_path("purelib")).resolve()
        assert purelib in package.parents, (package, purelib)
        generated_package = Path(anycloud.__file__).resolve()
        assert purelib in generated_package.parents, (generated_package, purelib)
    else:
        expected = Path("python/extensions/anycloud_workflows").resolve()
        assert expected in package.parents, package

    generated_root = Path(anycloud.__path__[0])
    for source in generated_root.rglob("*.py"):
        contents = source.read_text(encoding="utf8")
        if source == generated_root / "__init__.py":
            assert [
                line.strip()
                for line in contents.splitlines()
                if "anycloud_workflows" in line
            ] == [
                "from anycloud_workflows import AsyncClient as AsyncClient",
                "from anycloud_workflows import Client as Client",
                "from anycloud_workflows import AsyncClient",
                "from anycloud_workflows import Client",
            ], source
            continue
        assert "anycloud_workflows" not in contents, source
    assert (package.parent / "py.typed").is_file()


def qualify_public_client_imports() -> None:
    imports = [
        "from anycloud import Client",
        "from anycloud import AsyncClient",
        "from anycloud_workflows import Client",
        "from anycloud_workflows import AsyncClient",
        textwrap.dedent(
            """
            import sys
            import anycloud
            from anycloud.api.deployments_api import DeploymentsApi
            from anycloud.models.deployment_summary import DeploymentSummary
            assert "Client" in anycloud.__all__
            assert "Client" in dir(anycloud)
            assert "Client" not in vars(anycloud)
            assert "AsyncClient" in anycloud.__all__
            assert "AsyncClient" in dir(anycloud)
            assert "AsyncClient" not in vars(anycloud)
            assert not any(
                name == "anycloud_workflows" or name.startswith("anycloud_workflows.")
                for name in sys.modules
            )
            from anycloud import Client
            """
        ),
    ]
    qualification = textwrap.dedent(
        """
        import inspect
        import typing
        import anycloud
        import anycloud_workflows
        from anycloud import AsyncClient, Client
        from anycloud.api_client import ApiClient
        from anycloud.exceptions import ApiException
        from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
        from anycloud.models.deployment_summary import DeploymentSummary
        from anycloud_workflows import AsyncJob, Job

        assert Client is anycloud_workflows.Client
        assert AsyncClient is anycloud_workflows.AsyncClient
        assert anycloud.AsyncClient is AsyncClient
        assert anycloud.Client is Client
        assert anycloud.ApiClient is ApiClient
        assert anycloud.ApiException is ApiException
        assert anycloud.DeploymentSummary is DeploymentSummary
        assert "Client" in anycloud.__all__
        assert "Client" in dir(anycloud)
        try:
            anycloud.unknown_facade_attribute
        except AttributeError:
            pass
        else:
            raise AssertionError("Unknown package attributes must raise AttributeError")

        for owner in (Client, Job, AsyncClient, AsyncJob):
            for _, method in inspect.getmembers(owner, inspect.isfunction):
                typing.get_type_hints(method)
        assert typing.get_type_hints(Client.submit)["return"] is Job
        assert typing.get_type_hints(Client.get)["return"] is Job
        assert typing.get_type_hints(Client.create_deployment)["return"] is DeploymentSummary
        assert typing.get_type_hints(Client.list_deployments)["return"] == list[DeploymentSummary]
        assert typing.get_type_hints(Job.resubmit)["return"] is WorkloadResubmitResponse
        assert typing.get_type_hints(AsyncClient.submit)["return"] is AsyncJob
        assert typing.get_type_hints(AsyncClient.get)["return"] is AsyncJob
        assert inspect.iscoroutinefunction(AsyncClient.submit)
        assert inspect.iscoroutinefunction(AsyncJob.wait_for_claim)
        """
    )
    for first_import in imports:
        subprocess.run(
            [sys.executable, "-c", first_import + "\n" + qualification],
            check=True,
        )


def qualify_terminal_polling() -> None:
    responses = iter([status("queued"), status("completed")])
    calls: list[tuple[str, str, float]] = []
    clients: list[object] = []

    class FakeWorkloadsApi:
        def __init__(self, client: object) -> None:
            clients.append(client)

        def get_workload_status_sync(
            self,
            workload_id: str,
            any_cloud_client_version: str,
            *,
            _request_timeout: float,
        ) -> SimpleNamespace:
            calls.append(
                (workload_id, any_cloud_client_version, _request_timeout)
            )
            return next(responses)

    client = object()
    with (
        patch.object(workloads, "WorkloadsApi", FakeWorkloadsApi),
        patch.object(workloads.time, "monotonic", side_effect=[0, 0, 1, 3]),
        patch.object(workloads.time, "sleep") as sleep,
    ):
        result = wait_for_terminal_workload(
            client,
            "training-1",
            "0.1.62",
            timeout_seconds=10,
        )

    assert result.workload.state == "completed"
    assert clients == [client]
    assert calls == [
        ("training-1", "0.1.62", 10),
        ("training-1", "0.1.62", 7),
    ]
    sleep.assert_called_once_with(2.0)


def qualify_timeout_and_inputs() -> None:
    class FakeWorkloadsApi:
        def __init__(self, _client: object) -> None:
            pass

        def get_workload_status_sync(
            self,
            _workload_id: str,
            _any_cloud_client_version: str,
            *,
            _request_timeout: float,
        ) -> SimpleNamespace:
            assert _request_timeout == 3
            return status("running")

    with (
        patch.object(workloads, "WorkloadsApi", FakeWorkloadsApi),
        patch.object(workloads.time, "monotonic", side_effect=[0, 0, 3]),
    ):
        try:
            wait_for_terminal_workload(
                object(),
                "training-2",
                "0.1.62",
                timeout_seconds=3,
            )
        except WorkloadWaitTimeout as error:
            assert "training-2" in str(error)
        else:
            raise AssertionError("Expected a workload timeout")

    for keyword in ("timeout_seconds", "poll_interval_seconds"):
        try:
            wait_for_terminal_workload(
                object(),
                "training-3",
                "0.1.62",
                timeout_seconds=0 if keyword == "timeout_seconds" else 1,
                poll_interval_seconds=0 if keyword == "poll_interval_seconds" else 1,
            )
        except ValueError as error:
            assert keyword in str(error)
        else:
            raise AssertionError(f"Expected invalid {keyword}")


def qualify_unbounded_terminal_polling() -> None:
    responses = iter([status("running"), status("completed")])
    request_timeouts: list[float | None] = []

    class FakeWorkloadsApi:
        def __init__(self, _client: object) -> None:
            pass

        def get_workload_status_sync(
            self,
            _workload_id: str,
            _any_cloud_client_version: str,
            *,
            _request_timeout: float | None,
        ) -> SimpleNamespace:
            request_timeouts.append(_request_timeout)
            return next(responses)

    with (
        patch.object(workloads, "WorkloadsApi", FakeWorkloadsApi),
        patch.object(workloads.time, "sleep") as sleep,
    ):
        result = wait_for_terminal_workload(
            object(),
            "training-unbounded",
            "0.1.62",
            timeout_seconds=None,
        )

    assert result.workload.state == "completed"
    assert request_timeouts == [None, None]
    sleep.assert_called_once_with(2.0)


def qualify_job_client() -> None:
    configurations: list[object] = []
    api_clients: list[object] = []
    submissions: list[tuple[str, WorkloadAdmissionInput, float]] = []
    status_calls: list[tuple[str, str, float]] = []
    termination_calls: list[tuple[str, str, float]] = []
    deployment_calls: list[tuple[str, str, float]] = []
    deployment = DeploymentSummary.model_construct(id="deployment-1", name="model deployments")
    deployment_response = DeploymentResponse(deployment=deployment)
    submitted = WorkloadAdmissionResponse(
        id="job-1",
        url="https://job-1.example.test",
    )
    running = generated_status("running")
    completed = generated_status("completed")
    terminated = MessageResponse(message="Termination scheduled")

    class FakeConfiguration:
        def __init__(self, *, host: str, access_token: str) -> None:
            self.host = host
            self.access_token = access_token
            configurations.append(self)

    class FakeApiClient:
        def __init__(self, configuration: FakeConfiguration) -> None:
            self.configuration = configuration
            self.closed = False
            api_clients.append(self)

        async def close(self) -> None:
            self.closed = True

    class FakeWorkloadAdmissionApi:
        def __init__(self, client: FakeApiClient) -> None:
            assert client is api_clients[0]

        def submit_workload_sync(
            self,
            sdk_version: str,
            request: WorkloadAdmissionInput,
            *,
            _request_timeout: float,
        ) -> WorkloadAdmissionResponse:
            submissions.append((sdk_version, request, _request_timeout))
            return submitted

        async def submit_workload(
            self, sdk_version: str, request: WorkloadAdmissionInput, *, _request_timeout: float
        ) -> WorkloadAdmissionResponse:
            submissions.append((sdk_version, request, _request_timeout))
            return WorkloadAdmissionResponse(id=request.actual_instance.id, submission_revision=0, claim_deadline_at=None)

    class FakeWorkloadsApi:
        def __init__(self, client: FakeApiClient) -> None:
            assert client is api_clients[0]

        def get_workload_status_sync(
            self,
            workload_id: str,
            sdk_version: str,
            *,
            _request_timeout: float,
        ) -> WorkloadStatusResponse:
            status_calls.append(
                (workload_id, sdk_version, _request_timeout)
            )
            return running

        def terminate_workload_sync(
            self,
            workload_id: str,
            sdk_version: str,
            *,
            _request_timeout: float,
        ) -> MessageResponse:
            termination_calls.append(
                (workload_id, sdk_version, _request_timeout)
            )
            return terminated

    class FakeDeploymentsApi:
        def __init__(self, client: FakeApiClient) -> None:
            assert client is api_clients[0]

        def get_deployment_sync(
            self,
            identifier: str,
            sdk_version: str,
            *,
            _request_timeout: float,
        ) -> DeploymentResponse:
            deployment_calls.append((identifier, sdk_version, _request_timeout))
            return deployment_response

    with tempfile.TemporaryDirectory() as directory:
        anycloud_directory = Path(directory)
        (anycloud_directory / ".token").write_text(
            "file-token\n", encoding="utf8"
        )
        (anycloud_directory / "api-url").write_text(
            "https://api.example.test/\n", encoding="utf8"
        )
        with (
            patch.object(job_workflows, "Configuration", FakeConfiguration),
            patch.object(job_workflows, "ThrottleRetryingApiClient", FakeApiClient),
            patch.object(
                job_workflows,
                "WorkloadAdmissionApi",
                FakeWorkloadAdmissionApi,
            ),
            patch.object(
                job_workflows,
                "WorkloadsApi",
                FakeWorkloadsApi,
            ),
            patch.object(job_workflows, "DeploymentsApi", FakeDeploymentsApi),
            patch.dict(
                os.environ,
                {
                    "ANYCLOUD_DIR": directory,
                    "API_URL": "https://api.example.test/",
                    "ANYCLOUD_API_TOKEN": "environment-api-token",
                    "GITHUB_TOKEN": "environment-token",
                },
                clear=True,
            ),
        ):
            with Client(request_timeout_seconds=12) as client:
                assert client.sdk_version == anycloud.__version__
                assert client.api_client is api_clients[0]
                job = client.submit(
                    "ghcr.io/acme/trainer:latest",
                    cloud_config={
                        "region": "us-east-1",
                        "spot": True,
                    },
                    credential_name="aws-prod",
                    gpu=["h100:8", "a100:8"],
                    env={"EPOCHS": "10"},
                    secrets=["wandb"],
                    docker_options={"shm_size": "8g"},
                    command=["python", "train.py"],
                    workload_id="job-1",
                )

                assert isinstance(job, Job)
                assert job.id == "job-1"
                assert job.submission is submitted
                assert job.last_status is None
                assert job.status() is running
                assert job.last_status is running
                assert job.terminate() is terminated
                with patch.object(
                    job_workflows,
                    "wait_for_terminal_workload",
                    return_value=completed,
                ) as wait:
                    assert (
                        job.wait(
                            timeout_seconds=10,
                            poll_interval_seconds=0.25,
                        )
                        is job
                    )
                wait.assert_called_once_with(
                    api_clients[0],
                    "job-1",
                    anycloud.__version__,
                    timeout_seconds=10,
                    poll_interval_seconds=0.25,
                )
                assert job.last_status is completed
                targeted = client.submit(
                    deployment=" model deployments ", workload_id="reservation-1"
                )
                assert isinstance(targeted, Job)
                assert targeted.submission.id == "reservation-1"
                assert len(client.submit(deployment="deployment-1").id) == 28
                assert client.get_deployment(" model deployments ") is deployment
                assert client.get_deployment("deployment-1") is deployment

            client.close()
            for operation in (
                lambda: client.submit(deployment="deployment-1"),
                lambda: client.get_deployment("deployment-1"),
                targeted.status,
            ):
                try:
                    operation()
                except RuntimeError as error:
                    assert str(error) == "Client is closed"
                else:
                    raise AssertionError("Expected the closed client to fail")

    configuration = configurations[0]
    assert configuration.host == "https://api.example.test/v1"
    assert configuration.access_token == "environment-api-token"
    assert api_clients[0].closed
    assert status_calls == [("job-1", anycloud.__version__, 12)]
    assert termination_calls == [("job-1", anycloud.__version__, 12)]
    assert deployment_calls == [
        ("model deployments", anycloud.__version__, 12),
        ("deployment-1", anycloud.__version__, 12),
    ]
    assert len(submissions) == 3
    sdk_version, request, request_timeout = submissions[0]
    assert sdk_version == anycloud.__version__
    assert request_timeout == 12
    assert isinstance(request.actual_instance, WorkloadAdmissionInputAnyOf1)
    assert request.to_dict() == {
        "cloudConfig": {
            "region": "us-east-1",
            "spot": True,
        },
        "command": ["python", "train.py"],
        "credentialName": "aws-prod",
        "workloadType": "job",
        "dockerOptions": {"shmSize": "8g"},
        "env": {"EPOCHS": "10"},
        "gpuType": ["h100:8", "a100:8"],
        "id": "job-1",
        "image": "ghcr.io/acme/trainer:latest",
        "secrets": ["wandb"],
    }
    sdk_version, request, request_timeout = submissions[1]
    assert sdk_version == anycloud.__version__
    assert 0 < request_timeout <= 12
    assert isinstance(request.actual_instance, WorkloadAdmissionInputAnyOf)
    assert request.to_dict() == {
        "deployment": "model deployments",
        "id": "reservation-1",
        "workloadType": "job",
    }
    generated_id = submissions[2][1].actual_instance.id
    assert len(generated_id) == 28 and generated_id.startswith("job-")
    assert submissions[2][1].to_dict() == {
        "deployment": "deployment-1",
        "workloadType": "job",
        "id": generated_id,
    }


def qualify_job_waiting() -> None:
    submission = WorkloadAdmissionResponse(id="job-1")
    completed = generated_status("completed")
    failed = generated_status("failed")
    calls: list[tuple[object, str, str, float | None, float]] = []
    terminations = 0

    class FakeClient:
        api_client = object()
        sdk_version = "0.1.62"

        def _wait(
            self,
            workload_id: str,
            *,
            timeout_seconds: float | None,
            poll_interval_seconds: float,
        ) -> WorkloadStatusResponse:
            calls.append(
                (
                    self.api_client,
                    workload_id,
                    self.sdk_version,
                    timeout_seconds,
                    poll_interval_seconds,
                )
            )
            return completed

        def _terminate(self, _workload_id: str) -> MessageResponse:
            nonlocal terminations
            terminations += 1
            return MessageResponse(message="Termination scheduled")

    client = FakeClient()
    job = Job(client, submission)
    assert job.wait(timeout_seconds=10, poll_interval_seconds=0.25) is job
    assert job.last_status is completed
    assert calls == [(client.api_client, "job-1", "0.1.62", 10, 0.25)]

    client._wait = lambda *_args, **_kwargs: failed
    try:
        job.wait(timeout_seconds=10)
    except JobFailedError as error:
        assert error.status is failed
        assert error.workload_id == "job-1"
        assert error.state == "failed"
    else:
        raise AssertionError("Expected an unsuccessful Job to fail its wait")

    def timeout(*_args: object, **_kwargs: object) -> WorkloadStatusResponse:
        raise WorkloadWaitTimeout("still running")

    client._wait = timeout
    try:
        job.wait(timeout_seconds=0.1)
    except WorkloadWaitTimeout:
        pass
    else:
        raise AssertionError("Expected Job waiting to time out")
    assert terminations == 0


def qualify_job_api_error_propagation() -> None:
    api_error = ApiException(status=503, reason="API unavailable")

    class FakeConfiguration:
        def __init__(self, *, host: str, access_token: str) -> None:
            self.host = host
            self.access_token = access_token

    class FakeApiClient:
        def __init__(self, configuration: FakeConfiguration) -> None:
            self.configuration = configuration

        async def close(self) -> None:
            pass

    class FakeWorkloadAdmissionApi:
        def __init__(self, _client: FakeApiClient) -> None:
            pass

        def submit_workload_sync(
            self,
            _sdk_version: str,
            _request: WorkloadAdmissionInput,
            *,
            _request_timeout: float,
        ) -> WorkloadAdmissionResponse:
            raise api_error

        async def submit_workload(self, *_args: object, **_kwargs: object) -> WorkloadAdmissionResponse:
            raise api_error

    class FakeWorkloadsApi:
        def __init__(self, _client: FakeApiClient) -> None:
            pass

        def get_workload_status_sync(
            self,
            _workload_id: str,
            _sdk_version: str,
            *,
            _request_timeout: float,
        ) -> WorkloadStatusResponse:
            raise api_error

        def terminate_workload_sync(
            self,
            _workload_id: str,
            _sdk_version: str,
            *,
            _request_timeout: float,
        ) -> MessageResponse:
            raise api_error

    class FakeDeploymentsApi:
        def __init__(self, _client: FakeApiClient) -> None:
            pass

        def get_deployment_sync(
            self,
            _identifier: str,
            _sdk_version: str,
            *,
            _request_timeout: float,
        ) -> DeploymentResponse:
            raise api_error

    with (
        patch.object(job_workflows, "Configuration", FakeConfiguration),
        patch.object(job_workflows, "ThrottleRetryingApiClient", FakeApiClient),
        patch.object(
            job_workflows,
            "WorkloadAdmissionApi",
            FakeWorkloadAdmissionApi,
        ),
        patch.object(job_workflows, "WorkloadsApi", FakeWorkloadsApi),
        patch.object(job_workflows, "DeploymentsApi", FakeDeploymentsApi),
        patch.object(workloads, "WorkloadsApi", FakeWorkloadsApi),
    ):
        with Client(
            api_url="https://api.example.test",
            token="explicit-token",
        ) as client:
            job = Job(client, WorkloadAdmissionResponse(id="job-1"))
            operations = (
                lambda: client.submit("ghcr.io/acme/trainer:latest"),
                lambda: client.get_deployment("deployment-1"),
                job.status,
                lambda: job.wait(timeout_seconds=1),
                job.terminate,
            )
            try:
                client.submit(deployment="deployment-1")
            except JobSubmissionUncertain as error:
                assert error.cause is api_error and error.__cause__ is api_error
                assert len(error.job.id) == 28
            else:
                raise AssertionError("Expected a retained handle for uncertain Deployment admission")
            for operation in operations:
                try:
                    operation()
                except ApiException as error:
                    assert error is api_error
                else:
                    raise AssertionError(
                        "Expected the generated API exception to propagate"
                    )


def qualify_job_client_discovery_and_inputs() -> None:
    with tempfile.TemporaryDirectory() as directory:
        with patch.dict(
            os.environ,
            {
                "ANYCLOUD_DIR": directory,
                "API_URL": "https://environment.example.test/",
                "ANYCLOUD_API_TOKEN": "environment-api-token",
                "GITHUB_TOKEN": "github-token",
            },
            clear=True,
        ):
            assert job_workflows._resolve_api_url(None) == (
                "https://environment.example.test"
            )
            remote = "https://environment.example.test"
            assert job_workflows._resolve_token(None, remote) == (
                "environment-api-token"
            )
            # ANYCLOUD_API_TOKEN follows API_URL and never reaches another API.
            try:
                job_workflows._resolve_token(None, "https://other.example.test")
            except ValueError as error:
                assert "anycloud login https://other.example.test" in str(error)
            else:
                raise AssertionError("Expected another API to need its own token")
            assert job_workflows._resolve_api_url(
                "https://explicit.example.test/v1/"
            ) == "https://explicit.example.test/v1"
            assert job_workflows._resolve_token(" explicit-token ", remote) == (
                "explicit-token"
            )

        with patch.dict(
            os.environ,
            {
                "ANYCLOUD_DIR": directory,
                "GITHUB_TOKEN": "github-token",
            },
            clear=True,
        ):
            assert job_workflows._resolve_api_url(None) == (
                "http://localhost:8080"
            )
            # A loopback API takes only the token `anycloud api start` wrote.
            try:
                job_workflows._resolve_token(None, "http://localhost:8080")
            except ValueError as error:
                assert "anycloud api start" in str(error)
            else:
                raise AssertionError("Expected a missing local API token to fail")
            Path(directory, "local-api-token").write_text("local-token\n")
            assert (
                job_workflows._resolve_token(None, "http://localhost:8080")
                == "local-token"
            )
            # A hosted API takes the token `anycloud login <api>` saved.
            Path(directory, "api-tokens.json").write_text(
                json.dumps({"https://api.example.test": "saved-api-token"})
            )
            assert (
                job_workflows._resolve_token(None, "https://api.example.test")
                == "saved-api-token"
            )
            # One spelling: the URL exactly as the CLI's login saved it.
            try:
                job_workflows._resolve_token(None, "https://api.example.test/v1")
            except ValueError as error:
                assert "No API token" in str(error)
            else:
                raise AssertionError("Expected only the saved spelling to match")
            Path(directory, "api-tokens.json").unlink()
            # An unreadable sign-in counts as signed out beside a local token.
            Path(directory, ".token").mkdir()
            with warnings.catch_warnings(record=True):
                warnings.simplefilter("always")
                assert job_workflows._optional_github_token() == ""
            Path(directory, ".token").rmdir()

        # ANYCLOUD_TOKEN is not a token source.
        with patch.dict(
            os.environ,
            {"ANYCLOUD_DIR": directory, "ANYCLOUD_TOKEN": "anycloud-token"},
            clear=True,
        ):
            try:
                job_workflows._resolve_token(None, "https://api.example.test")
            except ValueError as error:
                assert "No API token" in str(error)
            else:
                raise AssertionError("Expected missing authentication to fail")

    for factory, expected in (
        (lambda: job_workflows._resolve_token("", "http://localhost:8080"), "token"),
        (lambda: job_workflows._resolve_api_url("relative"), "API URL"),
        (
            lambda: job_workflows._resolve_api_url(
                "https://api.example.test:notaport"
            ),
            "API URL",
        ),
        (
            lambda: job_workflows._resolve_api_url(
                "https://api.example.test:99999"
            ),
            "API URL",
        ),
        (lambda: job_workflows._string_sequence("python", "command"), "command"),
    ):
        try:
            factory()
        except (TypeError, ValueError) as error:
            assert expected in str(error)
        else:
            raise AssertionError(f"Expected invalid {expected} to fail")


def qualify_targeted_job_inputs() -> None:
    with (
        Client(api_url="https://api.example.test", token="explicit-token") as client,
        patch.object(client._admission, "submit_workload_sync") as submit,
        patch.object(client._deployments, "get_deployment_sync") as get_deployment,
    ):
        for arguments, expected in (
            ({}, "Exactly one"),
            ({"image": "trainer:latest", "deployment": "deployment-1"}, "Exactly one"),
            ({"deployment": ""}, "deployment cannot be empty"),
            ({"deployment": " \t "}, "deployment cannot be empty"),
        ):
            try:
                client.submit(**arguments)
            except ValueError as error:
                assert expected in str(error)
            else:
                raise AssertionError("Expected an invalid submission target to fail")

        for name, value in (
            ("cloud_config", {"region": "us-east-1"}),
            ("cloud_config", {"output_bucket": "must-not-be-mounted"}),
            ("cloud_config", {}),
            ("credential_name", "aws-prod"),
            ("credential_name", ""),
            ("gpu", "h100:8"),
            ("gpu", []),
            ("env", {"MODEL": "example"}),
            ("env", {}),
            ("secrets", ["training"]),
            ("secrets", []),
            ("docker_options", {"shm_size": "8g"}),
            ("docker_options", {}),
            ("command", ["python", "train.py"]),
            ("command", []),
        ):
            try:
                client.submit(deployment="deployment-1", **{name: value})
            except ValueError as error:
                assert name in str(error)
            else:
                raise AssertionError(f"Expected targeted {name} to fail")

        for identifier in ("", " \t "):
            try:
                client.get_deployment(identifier)
            except ValueError as error:
                assert "identifier cannot be empty" in str(error)
            else:
                raise AssertionError("Expected an empty Deployment identifier to fail")
        submit.assert_not_called()
        get_deployment.assert_not_called()


def deployment_summary_body() -> dict[str, object]:
    return {
        "id": "deployment-1",
        "name": "model deployments",
        "nodePoolId": "node-pool-1",
        "managed": False,
        "privileged": False,
        "target": {"kind": "nodePool", "nodePoolId": "node-pool-1"},
        "image": "deployment:latest",
        "command": None,
        "readinessProbe": None,
        "gracePeriodSeconds": 30,
        "status": None,
        "gpuCount": 0,
        "envKeys": [],
        "secretNames": [],
        "maxConcurrentJobsPerReplica": 3,
        "minReplicas": 1,
        "maxReplicas": 1,
        "generation": 2,
        "deletionRequestedAt": None,
        "deletedAt": None,
        "createdAt": 1,
        "updatedAt": 2,
        "jobs": {
            "queued": 3,
            "running": 1,
            "retrying": 0,
            "terminal": 0,
            "unreleased": 1,
        },
        "workload": {
            "observedGeneration": 2,
            "podName": "deployment-pod",
            "podUid": "pod-1",
            "containerId": "container-1",
            "containerReady": True,
            "pendingReason": None,
        },
        "usage": None,
    }


def qualify_job_client_wire() -> None:
    requests: list[httpx.Request] = []
    observations = iter([("queued", 2), ("queued", 0), ("running", None)])
    deployment_body = deployment_summary_body()

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST" and request.url.path == "/v1/workloads":
            return httpx.Response(
                202, json={"id": json.loads(request.content).get("id", "wire-job"), "submissionRevision": 0, "claimDeadlineAt": None}
            )
        assert request.method == "GET"
        if request.url.path == "/v1/workloads/wire-targeted":
            state, jobs_ahead = next(observations)
            return httpx.Response(
                200,
                json={
                    "workload": {
                        **_EMPTY_WORKLOAD_FIELDS,
                        "id": "wire-targeted",
                        "deploymentId": "deployment-1",
                        "submissionRevision": 0,
                        "claimDeadlineAt": None,
                        "claimed": state == "running",
                        "userId": "user-1",
                        "workloadType": "job",
                        "image": "deployment:latest",
                        "spot": False,
                        "state": state,
                        "startedAt": 0,
                        "dockerCommand": "",
                        "vmCount": 0,
                    },
                    "events": [],
                    "status": "-",
                    "jobsAhead": jobs_ahead,
                },
            )
        if request.url.path == "/v1/deployments/model deployments":
            return httpx.Response(200, json={"deployment": deployment_body})
        if request.url.path == "/v1/deployments/deployment-1":
            return httpx.Response(
                200,
                json={
                    "deployment": {
                        **deployment_body,
                        "deletionRequestedAt": 3,
                        "deletedAt": 4,
                        "workload": None,
                    }
                },
            )
        raise AssertionError(f"Unexpected SDK request: {request.method} {request.url}")

    with Client(
        api_url="https://api.example.test",
        token="explicit-token",
        request_timeout_seconds=12,
    ) as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        job = client.submit(
            "ghcr.io/acme/trainer:latest",
            credential_name="aws-prod",
            gpu="h100:8",
            cloud_config={
                "input_storage_credentials": {
                    "access_key_id": "storage-access-key",
                    "cloud_provider": "AWS",
                    "secret_access_key": "storage-secret-key",
                },
                "region": "us-east-1",
                "output_bucket": "training-results",
            },
        )
        targeted = client.submit(
            deployment="model deployments", workload_id="wire-targeted"
        )
        assert targeted.id == "wire-targeted"
        for state, ahead in (("queued", 2), ("queued", 0), ("running", None)):
            observed = targeted.status()
            assert isinstance(observed, WorkloadStatusResponse)
            assert observed.workload.state == state
            assert observed.jobs_ahead == ahead
            assert targeted.last_status is observed

        deployment = client.get_deployment("model deployments")
        assert isinstance(deployment, DeploymentSummary)
        assert deployment.id == "deployment-1"
        assert deployment.jobs.queued == 3
        assert deployment.jobs.unreleased == 1
        assert deployment.workload.container_ready
        assert deployment.workload.observed_generation == deployment.generation
        deleted = client.get_deployment(deployment.id)
        assert deleted.deletion_requested_at == 3
        assert deleted.deleted_at == 4
        assert deleted.workload is None

    assert job.id == "wire-job"
    assert len(requests) == 7
    for request in requests:
        assert request.headers["AnyCloud-Client-Version"] == anycloud.__version__
        assert request.headers["Authorization"] == "Bearer explicit-token"
        assert all(0 < value <= 12 for value in request.extensions["timeout"].values())
    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://api.example.test/v1/workloads"
    assert json.loads(request.content) == {
        "cloudConfig": {
            "inputStorageCredentials": {
                "accessKeyId": "storage-access-key",
                "cloudProvider": "AWS",
                "secretAccessKey": "storage-secret-key",
            },
            "region": "us-east-1",
            "outputBucket": "training-results",
        },
        "credentialName": "aws-prod",
        "workloadType": "job",
        "gpuType": "h100:8",
        "image": "ghcr.io/acme/trainer:latest",
    }
    assert json.loads(requests[1].content) == {
        "deployment": "model deployments",
        "workloadType": "job",
        "id": "wire-targeted",
    }
    assert str(requests[-2].url) == (
        "https://api.example.test/v1/deployments/model%20deployments"
    )
    assert str(requests[-1].url) == "https://api.example.test/v1/deployments/deployment-1"


def qualify_deployment_client_wire() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.path in {"/v1/deployments", "/v1/deployments/model deployments"}
        body = deployment_summary_body()
        if request.method == "DELETE":
            body["deletionRequestedAt"] = 3
        else:
            assert request.method in {"POST", "PATCH"}
        return httpx.Response(202, json={"deployment": body})

    with Client(
        api_url="https://api.example.test",
        token="explicit-token",
        request_timeout_seconds=12,
    ) as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        deployment = client.create_deployment(
            "model deployments",
            "deployment:latest",
            node_pool="training",
            command=("python", "deployment.py"),
            env={"MODEL": "example"},
            secrets=("model-db",),
            docker_options={"shm_size": "8g", "gpus": "all", "runtime": "nvidia"},
            max_concurrent_jobs_per_replica=4,
            replicas=2,
        )
        assert isinstance(deployment, DeploymentSummary)
        assert deployment.id == "deployment-1"
        client.create_deployment("defaults", "deployment:latest", node_pool="training")
        client.update_deployment(" model deployments ", image="deployment:v2")
        client.update_deployment(
            "model deployments", command=None, env=None, secrets=None, docker_options=None
        )
        client.update_deployment("model deployments", command=[], env={})
        options = DockerOptions(shm_size="16g", gpus="2", runtime="nvidia")
        client.update_deployment(
            "model deployments",
            command=("python", "deployment.py"),
            env={"MODEL": "next"},
            docker_options=options,
            max_concurrent_jobs_per_replica=2,
            min_replicas=1,
            max_replicas=3,
        )
        assert options.to_dict() == {"shmSize": "16g", "gpus": "2", "runtime": "nvidia"}
        client.update_deployment("model deployments", docker_options={"cpus": "6"})
        client.update_deployment(
            "model deployments",
            docker_options={"memory": None, "shm_size": None, "privileged": False},
        )
        options_update = DeploymentDockerOptionsUpdate(binds=[], gpus=None)
        client.update_deployment("model deployments", docker_options=options_update)
        assert options_update.to_dict() == {"binds": [], "gpus": None}
        existing_options = DockerOptions(cpus="6", memory=None, binds=[], privileged=False)
        client.update_deployment("model deployments", docker_options=existing_options)
        assert existing_options.model_dump(by_alias=True, exclude_unset=True) == {
            "cpus": "6", "memory": None, "binds": [], "privileged": False
        }
        deleting = client.delete_deployment(" model deployments ")
        assert isinstance(deleting, DeploymentSummary)
        assert deleting.deletion_requested_at == 3
        assert deleting.deleted_at is None
        pool = client.api_client.rest_client.pool_manager

    assert pool.is_closed
    assert [request.method for request in requests] == [
        "POST", "POST", "PATCH", "PATCH", "PATCH", "PATCH",
        "PATCH", "PATCH", "PATCH", "PATCH", "DELETE"
    ]
    assert [json.loads(request.content) for request in requests[:-1]] == [
        {
            "name": "model deployments",
            "image": "deployment:latest",
            "nodePool": "training",
            "command": ["python", "deployment.py"],
            "env": {"MODEL": "example"},
            "secrets": ["model-db"],
            "dockerOptions": {"shmSize": "8g", "gpus": "all", "runtime": "nvidia"},
            "maxConcurrentJobsPerReplica": 4,
            "minReplicas": 2,
            "maxReplicas": 2,
        },
        {
            "name": "defaults",
            "image": "deployment:latest",
            "nodePool": "training",
            "maxConcurrentJobsPerReplica": 1,
        },
        {"image": "deployment:v2"},
        {"command": None, "env": None, "secrets": None, "dockerOptions": None},
        {"command": [], "env": {}},
        {
            "command": ["python", "deployment.py"],
            "env": {"MODEL": "next"},
            "dockerOptions": {"shmSize": "16g", "gpus": "2", "runtime": "nvidia"},
            "maxConcurrentJobsPerReplica": 2,
            "minReplicas": 1,
            "maxReplicas": 3,
        },
        {"dockerOptions": {"cpus": "6"}},
        {"dockerOptions": {"memory": None, "shmSize": None, "privileged": False}},
        {"dockerOptions": {"binds": [], "gpus": None}},
        {"dockerOptions": {"cpus": "6", "memory": None, "binds": [], "privileged": False}},
    ]
    for request in requests:
        assert request.headers["AnyCloud-Client-Version"] == anycloud.__version__
        assert request.headers["Authorization"] == "Bearer explicit-token"
        assert set(request.extensions["timeout"].values()) == {12}
    assert str(requests[-1].url).endswith("/deployments/model%20deployments")


def qualify_deployment_listing_wire() -> None:
    requests: list[httpx.Request] = []
    expected_timeout = 30.0

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.method == "GET"
        assert request.url.path == "/v1/deployments"
        assert not request.content
        assert request.headers["AnyCloud-Client-Version"] == anycloud.__version__
        assert request.headers["Authorization"] == "Bearer explicit-token"
        assert set(request.extensions["timeout"].values()) == {expected_timeout}
        node_pool = request.url.params.get("nodePool")
        if node_pool == "unauthorized":
            return httpx.Response(401, json={"error": "Unauthorized"})
        if node_pool == "timeout":
            raise httpx.ReadTimeout("Deployment listing timed out", request=request)
        return httpx.Response(
            200, json={"deployments": [] if node_pool == "empty" else [deployment_summary_body()]}
        )

    with Client(api_url="https://api.example.test", token="explicit-token") as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        listed = client.list_deployments()
        assert isinstance(listed, list)
        assert isinstance(listed[0], DeploymentSummary)
        assert listed[0].id == "deployment-1"
        assert listed[0].jobs.queued == 3
        assert not requests[-1].url.query

    expected_timeout = 10.0
    with Client(
        api_url="https://api.example.test",
        token="explicit-token",
        request_timeout_seconds=expected_timeout,
    ) as client:
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        for node_pool in (None, "training pool", "node-pool-1", "empty"):
            listed = client.list_deployments(node_pool=node_pool)
            assert [deployment.id for deployment in listed] == (
                [] if node_pool == "empty" else ["deployment-1"]
            )
            assert dict(requests[-1].url.params) == (
                {} if node_pool is None else {"nodePool": node_pool}
            )

        for operation in (
            lambda: client.list_deployments("node-pool-1"),
            lambda: client.list_deployments(node_pool=""),
        ):
            before = len(requests)
            try:
                operation()
            except (TypeError, ValueError):
                pass
            else:
                raise AssertionError("Expected invalid Deployment listing arguments to fail")
            assert len(requests) == before

        for node_pool, expected_exception in (
            ("unauthorized", UnauthorizedException),
            ("timeout", httpx.ReadTimeout),
        ):
            before = len(requests)
            try:
                client.list_deployments(node_pool=node_pool)
            except expected_exception:
                pass
            else:
                raise AssertionError(f"Expected Deployment listing error for {node_pool}")
            assert len(requests) == before + 1

    before = len(requests)
    try:
        client.list_deployments()
    except RuntimeError as error:
        assert str(error) == "Client is closed"
    else:
        raise AssertionError("Expected Deployment listing on a closed client to fail")
    assert len(requests) == before


def qualify_detached_job_wire() -> None:
    requests: list[httpx.Request] = []
    state = "running"
    cleaned = False

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal state
        requests.append(request)
        identifier = request.url.path.split("/")[3]
        if identifier == "missing":
            return httpx.Response(404, json={"error": "Workload not found"})
        if identifier == "unauthorized":
            return httpx.Response(401, json={"error": "Unauthorized"})
        if identifier == "timeout":
            raise httpx.ReadTimeout("status read timed out", request=request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "workload": {
                        **_EMPTY_WORKLOAD_FIELDS,
                        "id": identifier,
                        "deploymentId": "deployment-1",
                        "submissionRevision": 0,
                        "claimDeadlineAt": None,
                        "claimed": state == "running",
                        "userId": "user-1",
                        "workloadType": identifier if identifier in {"vm", "service"} else "job",
                        "image": "deployment:latest",
                        "spot": False,
                        "state": state,
                        "startedAt": 0,
                        "dockerCommand": "",
                        "vmCount": 0,
                    },
                    "events": [],
                    "status": "-",
                    "jobsAhead": 0 if state == "queued" else None,
                },
            )
        if request.method == "DELETE":
            state = "terminated"
            return httpx.Response(202, json={"message": "Termination scheduled"})
        assert request.method == "POST"
        assert request.url.path == "/v1/workloads/detached-job/resubmissions"
        assert json.loads(request.content) == {}
        if not cleaned:
            return httpx.Response(400, json={"error": "Resources are still being released"})
        state = "queued"
        return httpx.Response(202, json={"message": "Workload resubmitted", "submissionRevision": 1, "claimDeadlineAt": None})

    def fresh_client() -> Client:
        client = Client(
            api_url="https://api.example.test",
            token="explicit-token",
            request_timeout_seconds=12,
        )
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        return client

    with fresh_client() as client:
        job = client.get(" detached-job ")
        assert len(requests) == 1
        assert job.id == "detached-job"
        assert job.submission is None
        assert isinstance(job.last_status, WorkloadStatusResponse)
        observed = job.last_status
        assert job.status() is not observed
        assert len(requests) == 2
        assert isinstance(job.terminate(), MessageResponse)
        observed = job.status()
        assert observed.workload.state == "terminated"
        try:
            job.resubmit()
        except BadRequestException as error:
            assert error.status == 400
            assert "still being released" in error.body
        else:
            raise AssertionError("Expected resubmission before cleanup to fail")
        assert job.last_status is observed

    cleaned = True
    with fresh_client() as client:
        attached = client.get(job.id)
        assert attached.last_status.workload.state == "terminated"
        response = attached.resubmit()
        assert isinstance(response, WorkloadResubmitResponse)
        assert response.message == "Workload resubmitted"
        assert attached.id == job.id
        assert attached.submission is None
        assert attached.last_status is None
        assert attached.status().workload.state == "queued"
        state = "completed"
        assert attached.wait(timeout_seconds=1) is attached
        assert attached.last_status.workload.state == "completed"
        wait_request = requests[-1]
        assert 0 < wait_request.extensions["timeout"]["read"] <= 1

        for identifier, expected_exception in (
            ("missing", NotFoundException),
            ("unauthorized", UnauthorizedException),
            ("timeout", httpx.ReadTimeout),
        ):
            before = len(requests)
            try:
                client.get(identifier)
            except expected_exception:
                pass
            else:
                raise AssertionError(f"Expected immediate attachment error for {identifier}")
            assert len(requests) == before + 1
        for kind in ("vm", "service"):
            try:
                client.get(kind)
            except ValueError as error:
                assert kind in str(error)
                assert "only Job handles" in str(error)
            else:
                raise AssertionError("Expected non-Job attachment to fail")

    for request in requests:
        assert request.headers["AnyCloud-Client-Version"] == anycloud.__version__
        assert request.headers["Authorization"] == "Bearer explicit-token"
        if request is wait_request:
            continue  # wait() shares its remaining deadline with the status request.
        assert all(0 < value <= 12 for value in request.extensions["timeout"].values())


def qualify_facade_inputs_and_response_identity() -> None:
    deployment = DeploymentSummary.model_construct(id="deployment-1", name="model deployments")
    response = DeploymentResponse(deployment=deployment)
    observed = generated_status("terminated")
    resubmitted = WorkloadResubmitResponse(message="Resubmitted", submission_revision=1, claim_deadline_at=None)
    with (
        Client(api_url="https://api.example.test", token="explicit-token") as client,
        patch.object(client._deployments, "create_deployment_sync", return_value=response) as create,
        patch.object(client._deployments, "update_deployment_sync", return_value=response) as update,
        patch.object(client._deployments, "delete_deployment_sync", return_value=response) as delete,
        patch.object(
            client._workloads, "get_workload_status_sync", return_value=observed
        ) as get,
        patch.object(
            client._workloads, "resubmit_workload", return_value=resubmitted
        ) as resubmit,
    ):
        assert client.create_deployment("deployment", "deployment:v1", node_pool="pool") is deployment
        assert client.update_deployment("deployment", image="deployment:v2") is deployment
        assert client.delete_deployment("deployment") is deployment
        attached = client.get("job-1")
        assert attached.last_status is observed
        assert attached.submission is None
        submission = WorkloadAdmissionResponse(id="job-1", url="https://job.example.test")
        submitted = Job(client, submission)
        assert submitted.status() is observed
        assert submitted.resubmit() is resubmitted
        assert attached.resubmit() is resubmitted
        assert attached.last_status is None
        assert attached.status() is observed
        assert submitted.submission is submission
        assert submitted.last_status is None

        for arguments in (
            {}, {"image": None},
            {"max_concurrent_jobs_per_replica": None},
            {"docker_options": {}},
            {"docker_options": DockerOptions()},
            {"docker_options": DeploymentDockerOptionsUpdate()},
            {"docker_options": {"cpus": 6}},
            {"docker_options": {"network": "host"}},
        ):
            before = update.call_count
            try:
                client.update_deployment("deployment", **arguments)
            except ValueError:
                pass
            else:
                raise AssertionError("Expected invalid update arguments to fail")
            assert update.call_count == before
        for operation in (
            lambda: client.get(" \t "),
            lambda: client.update_deployment(" \t ", image="deployment:v2"),
            lambda: client.delete_deployment(" \t "),
            lambda: client.create_deployment(
                "deployment", "deployment:v1", node_pool="pool", command="python"
            ),
            lambda: client.create_deployment(
                "deployment", "deployment:v1", node_pool="pool", gpus=True
            ),
            lambda: client.update_deployment("deployment", gpus=1),
            lambda: client.update_deployment("deployment", docker_options_update={"cpus": "6"}),
            lambda: client.create_deployment(
                "deployment", "deployment:v1", node_pool="pool", docker_options={"gpus": 1}
            ),
            lambda: client.update_deployment("deployment", docker_options={"gpus": True}),
            lambda: client.update_deployment("deployment", command="python"),
            lambda: client.update_deployment("deployment", max_concurrent_jobs_per_replica=0),
        ):
            counts = [mock.call_count for mock in (create, update, delete, get, resubmit)]
            try:
                operation()
            except (ValueError, TypeError):
                pass
            else:
                raise AssertionError("Expected invalid façade arguments to fail")
            assert counts == [mock.call_count for mock in (create, update, delete, get, resubmit)]

        api_error = ApiException(status=503, reason="API unavailable")
        for mock in (create, update, delete, get, resubmit):
            mock.side_effect = api_error
        operations = (
            lambda: client.create_deployment("deployment", "deployment:v1", node_pool="pool"),
            lambda: client.update_deployment("deployment", image="deployment:v2"),
            lambda: client.delete_deployment("deployment"),
            lambda: client.get("job-1"),
            attached.resubmit,
        )
        for operation in operations:
            try:
                operation()
            except ApiException as error:
                assert error is api_error
            else:
                raise AssertionError("Expected the generated API exception unchanged")
        assert attached.last_status is observed
        client.close()
        for operation in (*operations, attached.status, attached.terminate, attached.wait):
            try:
                operation()
            except RuntimeError as error:
                assert str(error) == "Client is closed"
            else:
                raise AssertionError("Expected the closed client to fail")


def qualify_current_deployment() -> None:
    execution_id = UUID("00000000-0000-4000-8000-000000000021")
    selected = SelectedJob(executionId=execution_id, jobId="job-1")
    api_error = ApiException(status=401, reason="Unauthorized")
    token_file = Path("deployment-token")
    calls: list[tuple[object, ...]] = []
    clients: list[FakeApiClient] = []

    class FakeConfiguration:
        def __init__(self, *, host: str) -> None:
            self.host = host
            self.access_token: str | None = None

    class FakeApiClient:
        def __init__(self, configuration: FakeConfiguration) -> None:
            self.configuration = configuration
            self.closed = False
            clients.append(self)

        async def close(self) -> None:
            self.closed = True

    class FakeDeploymentJobPoller:
        def __init__(
            self,
            client: FakeApiClient,
            deployment_id: str,
            *,
            request_timeout_seconds: float,
        ) -> None:
            assert client is clients[0]
            assert deployment_id == "deployment-1"
            assert request_timeout_seconds == 12

        def _deadlines(self, timeout: float) -> tuple[float, float]:
            assert timeout == 20
            return time.monotonic() + 12, time.monotonic() + timeout

        def _next_job(self, timeout: float, request_deadline: float, wait_deadline: float) -> SelectedJob:
            calls.append(("next", clients[0].configuration.access_token))
            return selected

    class FakeDeploymentWorkloadApi:
        def __init__(self, client: FakeApiClient) -> None:
            self._client = client

        async def get_deployment_job_cancellation(
            self,
            deployment_id: str,
            job_id: str,
            request_execution_id: UUID,
            *,
            wait_ms: int,
            _request_timeout: float,
        ) -> SimpleNamespace:
            calls.append(
                (
                    "cancellation",
                    clients[0].configuration.access_token,
                    deployment_id,
                    job_id,
                    request_execution_id,
                    _request_timeout,
                    wait_ms,
                )
            )
            return SimpleNamespace(cancelled=True)

        def report_deployment_job_outcome_sync(
            self,
            deployment_id: str,
            job_id: str,
            body: object,
            *,
            _request_timeout: float,
        ) -> None:
            calls.append(
                (
                    "outcome",
                    clients[0].configuration.access_token,
                    deployment_id,
                    job_id,
                    body,
                    _request_timeout,
                )
            )

        def cleanup_deployment_job_sync(
            self,
            deployment_id: str,
            job_id: str,
            body: object,
            *,
            _request_timeout: float,
        ) -> None:
            calls.append(
                (
                    "cleanup",
                    clients[0].configuration.access_token,
                    deployment_id,
                    job_id,
                    body,
                    _request_timeout,
                )
            )

    with (
        patch.object(deployments, "Configuration", FakeConfiguration),
        patch.object(deployments, "ApiClient", FakeApiClient),
        patch.object(deployments, "DeploymentJobPoller", FakeDeploymentJobPoller),
        patch.object(deployments, "DeploymentWorkloadApi", FakeDeploymentWorkloadApi),
        patch.object(
            deployments.Path,
            "read_text",
            side_effect=[
                "first-token\n",
                "second-token\n",
                "third-token\n",
                "fourth-token\n",
            ]
            + ["rotated-token\n"] * 7,
        ),
        patch.dict(
            os.environ,
            {
                "ANYCLOUD_API_URL": " https://api.example.test/ ",
                "ANYCLOUD_DEPLOYMENT_ID": " deployment-1 ",
                "ANYCLOUD_WORKLOAD_TOKEN_FILE": str(token_file),
            },
        ),
    ):
        with current_deployment(timeout_seconds=12) as deployment:
            assert isinstance(deployment, DeploymentContext)
            assert clients[0].configuration.host == "https://api.example.test/v1"
            job = deployment.next_job()
            assert isinstance(job, CurrentJob)
            assert job.id == "job-1"
            assert job.selected is selected
            assert deployment.cancellation_requested(selected)
            deployment.outcome(selected, "errored", "fixture error")
            deployment.cleanup(job)

            with (
                patch.object(
                    FakeDeploymentJobPoller, "_next_job", side_effect=api_error
                ),
                patch.object(
                    FakeDeploymentWorkloadApi,
                    "get_deployment_job_cancellation",
                    side_effect=api_error,
                ),
                patch.object(
                    FakeDeploymentWorkloadApi,
                    "report_deployment_job_outcome_sync",
                    side_effect=api_error,
                ),
                patch.object(
                    FakeDeploymentWorkloadApi,
                    "cleanup_deployment_job_sync",
                    side_effect=api_error,
                ),
            ):
                for operation in (
                    deployment.next_job,
                    job.complete,
                    lambda: job.error("fixture error"),
                    lambda: job.invalid("bad input"),
                    lambda: job.retry("temporary error"),
                    job.cancellation_requested,
                    job.cleanup,
                ):
                    try:
                        operation()
                    except ApiException as error:
                        assert error is api_error
                    else:
                        raise AssertionError(
                            "Expected the generated API exception to propagate"
                        )

        deployment.close()

    assert len(clients) == 2
    assert all(client.closed for client in clients)
    assert clients[0].configuration is clients[1].configuration
    assert calls[0] == ("next", "first-token")
    assert calls[1][:5] == (
        "cancellation",
        "second-token",
        "deployment-1",
        "job-1",
        execution_id,
    )
    assert 0 < calls[1][5] <= 12
    assert calls[1][6] == 0
    outcome = calls[2]
    assert outcome[:4] == ("outcome", "third-token", "deployment-1", "job-1")
    assert isinstance(outcome[4], WorkloadOutcomeBody)
    assert outcome[4].execution_id == execution_id
    assert outcome[4].outcome == "errored"
    assert outcome[4].message == "fixture error"
    assert outcome[5] == 12
    cleanup = calls[3]
    assert cleanup[:4] == ("cleanup", "fourth-token", "deployment-1", "job-1")
    assert isinstance(cleanup[4], WorkloadCleanupBody)
    assert cleanup[4].execution_id == execution_id
    assert cleanup[5] == 12


def qualify_current_job_wire() -> None:
    requests: list[httpx.Request] = []
    queued = {
        deployment_id: iter(["job-1", "job-2", None])
        for deployment_id in ("deployment-a", "deployment-b")
    }
    executions: dict[tuple[str, str], str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        parts = request.url.path.split("/")
        deployment_id = parts[3]
        if parts[-1] == "candidate":
            job_id = next(queued[deployment_id])
            return httpx.Response(204) if job_id is None else httpx.Response(
                200, json={"jobId": job_id, "submissionRevision": 0, "previousExecutionId": None}
            )
        if parts[-1] == "claim":
            job_id = parts[-2]
            execution_id = request.headers["Idempotency-Key"]
            executions[deployment_id, job_id] = execution_id
            return httpx.Response(
                200,
                json={"jobId": job_id, "executionId": execution_id},
            )
        if parts[-1] == "cancellation":
            return httpx.Response(
                200, json={"cancelled": parts[-2] == "job-1"}
            )
        return httpx.Response(204)

    with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
        jobs: list[CurrentJob] = []
        for deployment_id in queued:
            token_file = Path(directory) / deployment_id
            token_file.write_text(f"{deployment_id}-initial\n", encoding="utf8")
            deployment = stack.enter_context(
                DeploymentContext(
                    api_url="https://api.example.test",
                    deployment_id=deployment_id,
                    token_file=token_file,
                )
            )
            deployment._client.rest_client.pool_manager = httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            )
            for _ in range(2):
                job = deployment.next_job()
                assert isinstance(job, CurrentJob)
                assert isinstance(job.selected, SelectedJob)
                jobs.append(job)
            before_empty = len(requests)
            assert deployment.next_job() is None
            assert len(requests) == before_empty + 1
            token_file.write_text(f"{deployment_id}-rotated\n", encoding="utf8")

        outcomes = (
            (jobs[0], jobs[0].complete),
            (jobs[1], lambda: jobs[1].error("fixture error")),
            (jobs[2], lambda: jobs[2].invalid("bad input")),
            (jobs[3], lambda: jobs[3].retry("temporary error")),
        )

        def handle(
            job_and_outcome: tuple[CurrentJob, Callable[[], None]]
        ) -> None:
            job, report = job_and_outcome
            assert job.cancellation_requested() == (job.id == "job-1")
            report()
            job.cleanup()

        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(handle, outcomes))

    expected_outcomes = {
        ("deployment-a", "job-1"): {"outcome": "completed"},
        ("deployment-a", "job-2"): {"outcome": "errored", "message": "fixture error"},
        ("deployment-b", "job-1"): {"outcome": "invalid", "message": "bad input"},
        ("deployment-b", "job-2"): {
            "outcome": "retryable",
            "message": "temporary error",
        },
    }
    assert len(requests) == 22
    observed: set[tuple[str, str, str]] = set()
    for request in requests:
        parts = request.url.path.split("/")
        deployment_id, operation = parts[3], parts[-1]
        assert request.url.host == "api.example.test"
        assert request.url.path.startswith(f"/v1/deployments/{deployment_id}/jobs/")
        token = "initial" if operation in {"candidate", "claim"} else "rotated"
        assert request.headers["Authorization"] == f"Bearer {deployment_id}-{token}"
        assert request.method == ("GET" if operation in {"cancellation", "candidate"} else "POST")
        if operation in {"candidate", "claim"}:
            continue
        job_id = parts[-2]
        key = deployment_id, job_id
        observed.add((deployment_id, job_id, operation))
        if operation == "cancellation":
            assert dict(request.url.params) == {"executionId": executions[key], "waitMs": "0"}
        else:
            expected = {"executionId": executions[key]}
            if operation == "outcome":
                expected.update(expected_outcomes[key])
            assert json.loads(request.content) == expected
    assert observed == {
        (*key, operation)
        for key in expected_outcomes
        for operation in ("cancellation", "outcome", "cleanup")
    }


def qualify_current_deployment_inputs() -> None:
    with patch.dict(os.environ, {}, clear=True):
        try:
            current_deployment()
        except ValueError as error:
            assert "ANYCLOUD_API_URL" in str(error)
        else:
            raise AssertionError("Expected missing Deployment identity to fail")

    with patch.dict(os.environ, {
        "ANYCLOUD_API_URL": "https://api.example.test",
        "ANYCLOUD_WORKER_ID": "old-worker",
        "ANYCLOUD_WORKLOAD_TOKEN_FILE": "deployment-token",
    }, clear=True):
        try:
            current_deployment()
        except ValueError as error:
            assert "ANYCLOUD_DEPLOYMENT_ID" in str(error)
        else:
            raise AssertionError("Expected the removed Worker environment name to fail")

    try:
        DeploymentContext(
            api_url="https://api.example.test",
            deployment_id="deployment-1",
            token_file="deployment-token",
            timeout_seconds=0,
        )
    except ValueError as error:
        assert "timeout_seconds" in str(error)
    else:
        raise AssertionError("Expected an invalid Deployment timeout to fail")


def main() -> None:
    for removed in ("WorkerContext", "WorkerJobPoller", "current_worker"):
        assert not hasattr(anycloud_workflows, removed), removed
    for removed in ("create_worker", "list_workers", "get_worker", "update_worker", "delete_worker"):
        assert not hasattr(Client, removed), removed
        assert not hasattr(anycloud_workflows.AsyncClient, removed), removed
    assert not hasattr(anycloud_workflows, "DeploymentWaitTimeout")
    assert not hasattr(anycloud_workflows, "wait_for_terminal_deployment")
    assert not hasattr(anycloud_workflows, "async_wait_for_terminal_deployment")
    assert "workload_id" in inspect.signature(Client.submit).parameters
    assert "deployment" in inspect.signature(Client.submit).parameters
    assert "worker" not in inspect.signature(Client.submit).parameters
    assert "deployment_id" not in inspect.signature(Client.submit).parameters
    assert "workload_id" in inspect.signature(anycloud_workflows.AsyncClient.submit).parameters
    assert "deployment" in inspect.signature(anycloud_workflows.AsyncClient.submit).parameters
    assert "worker" not in inspect.signature(anycloud_workflows.AsyncClient.submit).parameters
    assert "deployment_id" not in inspect.signature(anycloud_workflows.AsyncClient.submit).parameters
    assert "deployment_id" not in inspect.signature(Job).parameters
    qualify_package_layout()
    qualify_request_deadlines()
    qualify_public_client_imports()
    qualify_terminal_polling()
    qualify_timeout_and_inputs()
    qualify_unbounded_terminal_polling()
    qualify_job_client()
    qualify_job_waiting()
    qualify_job_api_error_propagation()
    qualify_job_client_discovery_and_inputs()
    qualify_targeted_job_inputs()
    qualify_job_client_wire()
    qualify_deployment_client_wire()
    qualify_deployment_listing_wire()
    qualify_detached_job_wire()
    qualify_facade_inputs_and_response_identity()
    runpy.run_path(str(Path(__file__).with_name("qualify-deployment-claims.py")), run_name="__main__")
    runpy.run_path(str(Path(__file__).with_name("qualify-job-submissions.py")), run_name="__main__")
    runpy.run_path(str(Path(__file__).with_name("qualify-async-job-submissions.py")), run_name="__main__")
    runpy.run_path(str(Path(__file__).with_name("qualify-client-parity.py")), run_name="__main__")
    runpy.run_path(str(Path(__file__).with_name("qualify-bucket-throttle.py")), run_name="__main__")
    qualify_current_deployment()
    qualify_current_job_wire()
    qualify_cancellation_waits()
    qualify_cancellation_client_cleanup()
    qualify_current_deployment_inputs()


if __name__ == "__main__":
    main()
