"""Ergonomic Job workflows composed from generated API operations."""

from __future__ import annotations

import json
import math
import os
import time
import warnings
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, get_args
from urllib.parse import urlsplit

import anycloud
from anycloud.api.workload_admission_api import WorkloadAdmissionApi
from anycloud.api.workloads_api import WorkloadsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_admission_input_cloud_config import (
    WorkloadAdmissionInputCloudConfig,
)
from anycloud.models.workload_admission_input_cloud_config_vm_type import (
    WorkloadAdmissionInputCloudConfigVmType,
)
from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_body import WorkloadResubmitBody
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.docker_options import DockerOptions
from anycloud.sync_helper import run_sync

from ._bucket_throttle import ThrottleRetryingApiClient
from ._request_deadline import request_with_deadline
from .workloads import wait_for_terminal_workload

_DEFAULT_API_URL = "http://localhost:8080"

CloudConfigInput = WorkloadAdmissionInputCloudConfig | Mapping[str, Any]
DockerOptionsInput = DockerOptions | Mapping[str, Any]


def _anycloud_directory() -> Path:
    configured = os.environ.get("ANYCLOUD_DIR", "").strip()
    return Path(configured) if configured else Path.home() / ".anycloud"


_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_GITHUB_TOKEN_HEADER = "AnyCloud-GitHub-Token"


def _is_loopback(api_url: str) -> bool:
    return (urlsplit(api_url).hostname or "").lower() in _LOOPBACK_HOSTS


def _read_token_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf8").strip()
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise ValueError(f"Could not read AnyCloud token file {path}") from error


def _github_token() -> str:
    return _read_token_file(_anycloud_directory() / ".token") or os.environ.get("GITHUB_TOKEN", "").strip()


def _optional_github_token() -> str:
    """The sign-in a local API takes beside its token; unreadable counts as signed out."""
    try:
        return _github_token()
    except ValueError as error:
        warnings.warn(f"Continuing without a GitHub sign-in: {error}", stacklevel=3)
        return ""


def _saved_api_token(api_url: str) -> str:
    """The token `anycloud login <api>` saved under this exact URL; a damaged file holds none."""
    saved = _read_token_file(_anycloud_directory() / "api-tokens.json")
    try:
        tokens = json.loads(saved) if saved else {}
    except ValueError:
        return ""
    token = tokens.get(api_url) if isinstance(tokens, dict) else None
    return token if isinstance(token, str) else ""


def _resolve_token(explicit: str | None, api_url: str) -> str:
    """A local API's per-install token, which never leaves this machine, else the hosted API's own token."""
    if explicit is not None:
        token = explicit.strip()
        if not token:
            raise ValueError("token cannot be empty")
        return token

    if _is_loopback(api_url):
        token_file = _anycloud_directory() / "local-api-token"
        token = _read_token_file(token_file)
        if token:
            return token
        raise ValueError(f"No local API token at {token_file}; run 'anycloud api start'")

    # The variable follows API_URL, so it never reaches another API.
    environment_url = os.environ.get("API_URL", "").strip()
    environment_token = os.environ.get("ANYCLOUD_API_TOKEN", "").strip()
    if environment_token and environment_url and _normalize_api_url(environment_url) == api_url:
        return environment_token

    token = _saved_api_token(api_url)
    if token:
        return token

    raise ValueError(
        f"No API token for {api_url}; run 'anycloud login {api_url}', pass token=, "
        "or set ANYCLOUD_API_TOKEN with API_URL"
    )


def _normalize_api_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    if not normalized:
        raise ValueError("API URL cannot be empty")

    try:
        parsed = urlsplit(normalized)
        _ = parsed.port
    except ValueError as error:
        raise ValueError("API URL must contain a valid host and port") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("API URL must be an absolute http:// or https:// URL")
    if parsed.username or parsed.password:
        raise ValueError("API URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("API URL must not contain a query string or fragment")
    return normalized


def _resolve_api_url(explicit: str | None) -> str:
    if explicit is not None:
        return _normalize_api_url(explicit)

    environment = os.environ.get("API_URL", "").strip()
    if environment:
        return _normalize_api_url(environment)

    api_url_file = _anycloud_directory() / "api-url"
    try:
        persisted = api_url_file.read_text(encoding="utf8").strip()
    except FileNotFoundError:
        persisted = ""
    except OSError as error:
        raise ValueError(
            f"Could not read AnyCloud API URL file {api_url_file}"
        ) from error
    if persisted:
        return _normalize_api_url(persisted)

    return _DEFAULT_API_URL


def _generated_api_host(api_url: str) -> str:
    return api_url if api_url.endswith("/v1") else f"{api_url}/v1"


def _generated_model_types(annotation: Any) -> list[type[Any]]:
    models: list[type[Any]] = []
    pending = [annotation]
    while pending:
        candidate = pending.pop()
        if isinstance(candidate, type) and hasattr(candidate, "model_fields"):
            models.append(candidate)
        else:
            pending.extend(get_args(candidate))
    return models


def _generated_model_fields(annotation: Any) -> list[tuple[str, Any]]:
    fields: list[tuple[str, Any]] = []
    pending = _generated_model_types(annotation)
    visited: set[type[Any]] = set()
    while pending:
        model = pending.pop(0)
        if model in visited:
            continue
        visited.add(model)
        for name, field in model.model_fields.items():
            fields.append((name, field))
            pending.extend(_generated_model_types(field.annotation))
    return fields


def _wire_model_value(annotation: Any, value: Any) -> Any:
    if isinstance(value, Mapping):
        fields = _generated_model_fields(annotation)
        wire: dict[str, Any] = {}
        for name, item in value.items():
            matches = [
                field
                for field_name, field in fields
                if name == field_name or name == field.alias
            ]
            aliases = {field.alias or name for field in matches}
            if len(aliases) != 1:
                wire[name] = item
                continue
            field = matches[0]
            wire_name = aliases.pop()
            wire[wire_name] = _wire_model_value(field.annotation, item)
        return wire
    if isinstance(value, (list, tuple)):
        return [_wire_model_value(annotation, item) for item in value]
    return value


def _wire_model_input(model: type[Any], value: Mapping[str, Any]) -> dict[str, Any]:
    result = _wire_model_value(model, value)
    assert isinstance(result, dict)
    return result


def _cloud_config(
    value: CloudConfigInput | None,
) -> WorkloadAdmissionInputCloudConfig:
    if value is None:
        return WorkloadAdmissionInputCloudConfig()
    if isinstance(value, WorkloadAdmissionInputCloudConfig):
        return value
    result = WorkloadAdmissionInputCloudConfig.from_dict(
        _wire_model_input(WorkloadAdmissionInputCloudConfig, value)
    )
    assert result is not None
    return result


def _docker_options(value: DockerOptionsInput | None) -> DockerOptions | None:
    if value is None or isinstance(value, DockerOptions):
        return value
    return DockerOptions.from_dict(_wire_model_input(DockerOptions, value))


def _string_sequence(value: Sequence[str] | None, name: str) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        raise TypeError(f"{name} must be a sequence of strings, not one string")
    return list(value)


class _JobHandle:
    """Submission identity shared by sync and async handles."""

    def __init__(self, submission: WorkloadAdmissionResponse | str) -> None:
        if isinstance(submission, WorkloadAdmissionResponse):
            self._id = submission.id
            self._submission: WorkloadAdmissionResponse | None = submission
        else:
            self._id = submission
            self._submission = None
        self._last_status: WorkloadStatusResponse | None = None

    @property
    def id(self) -> str:
        return self._id

    @property
    def submission(self) -> WorkloadAdmissionResponse | None:
        """Return the admission response, or None for a reattached handle."""
        return self._submission

    @property
    def last_status(self) -> WorkloadStatusResponse | None:
        """Return the most recent generated status observed by this handle."""
        return self._last_status

    def _attach_status(self, status: WorkloadStatusResponse) -> None:
        if status.workload.workload_type != "job":
            raise ValueError(
                f"Workload {self.id!r} is a "
                f"{status.workload.workload_type!r}; only Job handles are supported"
            )
        self._last_status = status


class JobFailedError(RuntimeError):
    """Raised when a waited Job reaches an unsuccessful terminal state.

    The generated terminal response is available through :attr:`status`.
    """

    def __init__(self, status: WorkloadStatusResponse) -> None:
        self.status = status
        self.workload_id = status.workload.id
        self.state = status.workload.state
        super().__init__(
            f"Job {self.workload_id!r} reached unsuccessful terminal "
            f"state {self.state!r}"
        )


def _submission_input(
    image: str,
    *,
    cloud_config: CloudConfigInput | None,
    credential_name: str | None,
    gpu: str | Sequence[str] | None,
    env: Mapping[str, str] | None,
    secrets: Sequence[str] | None,
    docker_options: DockerOptionsInput | None,
    command: Sequence[str] | None,
    workload_id: str | None,
) -> WorkloadAdmissionInput:
    return WorkloadAdmissionInput(
        image=image,
        cloud_config=_cloud_config(cloud_config),
        credential_name=credential_name,
        gpu_type=(
            WorkloadAdmissionInputCloudConfigVmType(
                list(gpu) if not isinstance(gpu, str) else gpu
            )
            if gpu is not None
            else None
        ),
        env=dict(env) if env is not None else None,
        secrets=_string_sequence(secrets, "secrets"),
        docker_options=_docker_options(docker_options),
        command=_string_sequence(command, "command"),
        id=workload_id,
        workload_type="job",
    )


class _ClientBase:
    """Shared configuration and ownership of the generated API client."""

    def __init__(
        self,
        *,
        api_url: str | None = None,
        token: str | None = None,
        request_timeout_seconds: float = 30.0,
    ) -> None:
        if not math.isfinite(request_timeout_seconds) or request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be finite and greater than zero")

        resolved_api_url = _resolve_api_url(api_url)
        configuration = Configuration(
            host=_generated_api_host(resolved_api_url),
            access_token=_resolve_token(token, resolved_api_url),
        )
        self._api_client = ThrottleRetryingApiClient(configuration)
        github_token = _optional_github_token() if _is_loopback(resolved_api_url) else ""
        if github_token:
            self._api_client.set_default_header(_GITHUB_TOKEN_HEADER, github_token)
        self._admission = WorkloadAdmissionApi(self._api_client)
        self._workloads = WorkloadsApi(self._api_client)
        self._sdk_version = anycloud.__version__
        self._request_timeout_seconds = request_timeout_seconds
        self._closed = False

    @property
    def api_client(self) -> ApiClient:
        """Return the owned generated client for operations outside this helper."""

        self._ensure_open()
        return self._api_client

    @property
    def sdk_version(self) -> str:
        """Return the generated SDK version sent to management operations."""

        return self._sdk_version

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("Client is closed")


class Client(_ClientBase):
    """Optional synchronous workflows over the generated AnyCloud client."""

    def __enter__(self) -> Client:
        self._ensure_open()
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the generated API client owned by this helper."""

        if self._closed:
            return
        run_sync(self._api_client.close())
        self._closed = True

    def submit(
        self,
        image: str,
        *,
        cloud_config: CloudConfigInput | None = None,
        credential_name: str | None = None,
        gpu: str | Sequence[str] | None = None,
        env: Mapping[str, str] | None = None,
        secrets: Sequence[str] | None = None,
        docker_options: DockerOptionsInput | None = None,
        command: Sequence[str] | None = None,
        workload_id: str | None = None,
    ) -> Job:
        """Submit an image as a Job and return a Job handle.

        Use ``job.wait()`` for completion.
        """

        self._ensure_open()
        request = _submission_input(
            image,
            cloud_config=cloud_config,
            credential_name=credential_name,
            gpu=gpu,
            env=env,
            secrets=secrets,
            docker_options=docker_options,
            command=command,
            workload_id=workload_id,
        )
        submission = self._admission.submit_workload_sync(
            self._sdk_version,
            request,
            _request_timeout=self._request_timeout_seconds,
        )
        return Job(self, submission)

    def get(self, workload_id: str) -> Job:
        """Fetch an existing Job and attach a handle with its observed status."""

        self._ensure_open()
        workload_id = workload_id.strip()
        if not workload_id:
            raise ValueError("Job identifier cannot be empty")
        status = self._status(workload_id)
        job = Job(self, workload_id)
        job._attach_status(status)
        return job

    def _status(self, workload_id: str) -> WorkloadStatusResponse:
        self._ensure_open()
        return self._workloads.get_workload_status_sync(
            workload_id,
            self._sdk_version,
            _request_timeout=self._request_timeout_seconds,
        )

    def _wait(
        self,
        workload_id: str,
        *,
        timeout_seconds: float | None,
        poll_interval_seconds: float,
    ) -> WorkloadStatusResponse:
        self._ensure_open()
        return wait_for_terminal_workload(
            self._api_client,
            workload_id,
            self._sdk_version,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )

    def _terminate(self, workload_id: str) -> WorkloadResubmitResponse:
        self._ensure_open()
        return self._workloads.terminate_workload_sync(
            workload_id,
            self._sdk_version,
            _request_timeout=self._request_timeout_seconds,
        )

    def _resubmit(self, workload_id: str) -> WorkloadResubmitResponse:
        self._ensure_open()
        return request_with_deadline(
            self._workloads.resubmit_workload,
            workload_id,
            self._sdk_version,
            WorkloadResubmitBody(),
            deadline=time.monotonic() + self._request_timeout_seconds,
        )


class Job(_JobHandle):
    """Lightweight lifecycle handle for a submitted or reattached Job."""

    def __init__(
        self, client: Client, submission: WorkloadAdmissionResponse | str
    ) -> None:
        super().__init__(submission)
        self._client = client

    def status(self) -> WorkloadStatusResponse:
        """Fetch and return the generated workload status response."""

        self._last_status = self._client._status(self.id)
        return self._last_status

    def wait(
        self,
        *,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float = 2.0,
    ) -> Job:
        """Wait for successful completion and return this handle.

        Unsuccessful terminal states raise :class:`JobFailedError`. A
        :class:`WorkloadWaitTimeout` stops polling without terminating the Job.
        """

        self._last_status = self._client._wait(
            self.id,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )
        if self._last_status.workload.state != "completed":
            raise JobFailedError(self._last_status)
        return self

    def terminate(self) -> WorkloadResubmitResponse:
        """Schedule termination and return the generated response."""

        return self._client._terminate(self.id)

    def resubmit(self) -> WorkloadResubmitResponse:
        """Resubmit the same Job ID and return the generated response."""

        response = self._client._resubmit(self.id)
        self._last_status = None
        return response

    def __repr__(self) -> str:
        return f"Job({self.id!r})"
