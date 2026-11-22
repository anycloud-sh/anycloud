"""Qualify the handwritten Python workflow extension against generated imports."""

from __future__ import annotations

import json
import inspect
import os
import runpy
import warnings
import subprocess
import sys
import sysconfig
import tempfile
import textwrap
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from python_request_deadline import qualify_request_deadlines

import anycloud
import anycloud_workflows
import anycloud_workflows.workloads as workloads
import anycloud_workflows.jobs as job_workflows
import httpx
from anycloud.exceptions import (
    ApiException,
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
)
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.workload_status_response_workload import (
    WorkloadStatusResponseWorkload,
)
from anycloud_workflows import (
    Client,
    WorkloadWaitTimeout,
    Job,
    JobFailedError,
    wait_for_terminal_workload,
)


# Explicit nullable fields in the API's Job status projection.
_EMPTY_WORKLOAD_FIELDS = dict.fromkeys((
    "agent", "availabilityZone", "awaitingReleaseMs", "checkpointBucket",
    "checkpointStorageRegion", "cloudProvider", "command", "completedAt",
    "costSource", "diskIops", "diskSizeGb", "diskThroughputMibps", "diskTier", "dnsRecordId", "regions", "dockerOptions",
    "gpuType", "imageDigest", "inputBucket", "inputStorageRegion", "outputBucket",
    "outputStorageRegion", "region", "secretNames", "session", "sessionLabel",
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
            from anycloud.api.workloads_api import WorkloadsApi
            from anycloud.models.workload_status_response import WorkloadStatusResponse
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
        from anycloud.models.workload_status_response import WorkloadStatusResponse
        from anycloud_workflows import AsyncJob, Job

        assert Client is anycloud_workflows.Client
        assert AsyncClient is anycloud_workflows.AsyncClient
        assert anycloud.AsyncClient is AsyncClient
        assert anycloud.Client is Client
        assert anycloud.ApiClient is ApiClient
        assert anycloud.ApiException is ApiException
        assert anycloud.WorkloadStatusResponse is WorkloadStatusResponse
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
        assert typing.get_type_hints(Job.resubmit)["return"] is WorkloadResubmitResponse
        assert typing.get_type_hints(AsyncClient.submit)["return"] is AsyncJob
        assert typing.get_type_hints(AsyncClient.get)["return"] is AsyncJob
        assert inspect.iscoroutinefunction(AsyncClient.submit)
        assert inspect.iscoroutinefunction(AsyncJob.wait)
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
    submitted = WorkloadAdmissionResponse(
        id="job-1",
        url="https://job-1.example.test",
    )
    running = generated_status("running")
    completed = generated_status("completed")
    terminated = WorkloadResubmitResponse(message="Termination scheduled")

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
        ) -> WorkloadResubmitResponse:
            termination_calls.append(
                (workload_id, sdk_version, _request_timeout)
            )
            return terminated

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

            client.close()
            for operation in (
                lambda: client.submit("ghcr.io/acme/trainer:latest"),
                job.status,
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
    assert len(submissions) == 1
    sdk_version, request, request_timeout = submissions[0]
    assert sdk_version == anycloud.__version__
    assert request_timeout == 12
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

        def _terminate(self, _workload_id: str) -> WorkloadResubmitResponse:
            nonlocal terminations
            terminations += 1
            return WorkloadResubmitResponse(message="Termination scheduled")

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
        ) -> WorkloadResubmitResponse:
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
        patch.object(workloads, "WorkloadsApi", FakeWorkloadsApi),
    ):
        with Client(
            api_url="https://api.example.test",
            token="explicit-token",
        ) as client:
            job = Job(client, WorkloadAdmissionResponse(id="job-1"))
            operations = (
                lambda: client.submit("ghcr.io/acme/trainer:latest"),
                job.status,
                lambda: job.wait(timeout_seconds=1),
                job.terminate,
            )
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


def qualify_job_client_wire() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST" and request.url.path == "/v1/workloads":
            return httpx.Response(
                202, json={"id": json.loads(request.content).get("id", "wire-job")}
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

    assert job.id == "wire-job"
    assert len(requests) == 1
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
                        "userId": "user-1",
                        "workloadType": identifier if identifier in {"vm", "service"} else "job",
                        "image": "trainer:latest",
                        "spot": False,
                        "state": state,
                        "startedAt": 0,
                        "dockerCommand": "",
                        "vmCount": 0,
                    },
                    "events": [],
                    "status": "-",
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
        return httpx.Response(202, json={"message": "Workload resubmitted"})

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
        assert isinstance(job.terminate(), WorkloadResubmitResponse)
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
    observed = generated_status("terminated")
    resubmitted = WorkloadResubmitResponse(message="Resubmitted")
    with (
        Client(api_url="https://api.example.test", token="explicit-token") as client,
        patch.object(
            client._workloads, "get_workload_status_sync", return_value=observed
        ) as get,
        patch.object(
            client._workloads, "resubmit_workload", return_value=resubmitted
        ) as resubmit,
    ):
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

        for operation in (lambda: client.get(" \t "),):
            counts = [mock.call_count for mock in (get, resubmit)]
            try:
                operation()
            except (ValueError, TypeError):
                pass
            else:
                raise AssertionError("Expected invalid façade arguments to fail")
            assert counts == [mock.call_count for mock in (get, resubmit)]

        api_error = ApiException(status=503, reason="API unavailable")
        for mock in (get, resubmit):
            mock.side_effect = api_error
        operations = (
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


def main() -> None:
    for removed in (
        "WorkerContext",
        "WorkerJobPoller",
        "current_worker",
        "DeploymentContext",
        "DeploymentJobPoller",
        "CurrentJob",
        "current_deployment",
        "JobSubmissionUncertain",
        "DeploymentWaitTimeout",
        "wait_for_terminal_deployment",
        "async_wait_for_terminal_deployment",
    ):
        assert not hasattr(anycloud_workflows, removed), removed
    for removed in (
        "create_deployment",
        "list_deployments",
        "get_deployment",
        "update_deployment",
        "delete_deployment",
    ):
        assert not hasattr(Client, removed), removed
        assert not hasattr(anycloud_workflows.AsyncClient, removed), removed
    for submit in (Client.submit, anycloud_workflows.AsyncClient.submit):
        parameters = inspect.signature(submit).parameters
        assert "workload_id" in parameters
        for removed in ("deployment", "worker", "deployment_id", "timeout", "wait"):
            assert removed not in parameters, removed
    assert not hasattr(Job, "wait_for_claim")
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
    qualify_job_client_wire()
    qualify_detached_job_wire()
    qualify_facade_inputs_and_response_identity()
    runpy.run_path(str(Path(__file__).with_name("qualify-client-parity.py")), run_name="__main__")
    runpy.run_path(str(Path(__file__).with_name("qualify-bucket-throttle.py")), run_name="__main__")


if __name__ == "__main__":
    main()
