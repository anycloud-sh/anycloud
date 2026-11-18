"""Ergonomic Job workflows composed from generated API operations."""

from __future__ import annotations

import json
import math
import os
import secrets as random_secrets
import time
import warnings
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Generic, TypeVar, get_args
from urllib.parse import urlsplit

import anycloud
from anycloud.api.workload_admission_api import WorkloadAdmissionApi
from anycloud.api.workloads_api import WorkloadsApi
from anycloud.api.deployments_api import DeploymentsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration
from anycloud.exceptions import ApiException
from anycloud.models.create_deployment_input import CreateDeploymentInput
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_admission_input_any_of import (
    WorkloadAdmissionInputAnyOf,
)
from anycloud.models.workload_admission_input_any_of1 import (
    WorkloadAdmissionInputAnyOf1,
)
from anycloud.models.workload_admission_input_any_of1_cloud_config import (
    WorkloadAdmissionInputAnyOf1CloudConfig,
)
from anycloud.models.workload_admission_input_any_of1_cloud_config_vm_type import (
    WorkloadAdmissionInputAnyOf1CloudConfigVmType,
)
from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_body import WorkloadResubmitBody
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.docker_options import DockerOptions
from anycloud.models.job_submission_observation import JobSubmissionObservation
from anycloud.models.job_submission_observation_body import JobSubmissionObservationBody
from anycloud.models.job_submission_outcome import JobSubmissionOutcome
from anycloud.models.message_response import MessageResponse
from anycloud.models.update_deployment_body import UpdateDeploymentBody
from anycloud.models.deployment_docker_options_update import DeploymentDockerOptionsUpdate
from anycloud.models.deployment_summary import DeploymentSummary
from anycloud.models.deployment_readiness_probe import DeploymentReadinessProbe
from anycloud.sync_helper import run_sync

from ._bucket_throttle import ThrottleRetryingApiClient
from ._request_deadline import request_with_deadline
from .workloads import wait_for_terminal_workload

_DEFAULT_API_URL = "http://localhost:8080"

CloudConfigInput = WorkloadAdmissionInputAnyOf1CloudConfig | Mapping[str, Any]
DockerOptionsInput = DockerOptions | Mapping[str, Any]
DeploymentDockerOptionsUpdateInput = DeploymentDockerOptionsUpdate | DockerOptions | Mapping[str, Any]
DeploymentReadinessProbeInput = DeploymentReadinessProbe | Mapping[str, Any]


class _Unset:
    """Distinguish an omitted update field from an explicit null."""


_UNSET = _Unset()


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
) -> WorkloadAdmissionInputAnyOf1CloudConfig:
    if value is None:
        return WorkloadAdmissionInputAnyOf1CloudConfig()
    if isinstance(value, WorkloadAdmissionInputAnyOf1CloudConfig):
        return value
    result = WorkloadAdmissionInputAnyOf1CloudConfig.from_dict(
        _wire_model_input(WorkloadAdmissionInputAnyOf1CloudConfig, value)
    )
    assert result is not None
    return result


def _docker_options(value: DockerOptionsInput | None) -> DockerOptions | None:
    if value is None or isinstance(value, DockerOptions):
        return value
    return DockerOptions.from_dict(_wire_model_input(DockerOptions, value))


def _deployment_docker_options_update(
    value: DeploymentDockerOptionsUpdateInput | None,
) -> DeploymentDockerOptionsUpdate | None:
    if value is None:
        return None
    if isinstance(value, DeploymentDockerOptionsUpdate):
        update = value
    else:
        fields = (
            value.model_dump(by_alias=True, exclude_unset=True)
            if isinstance(value, DockerOptions)
            else _wire_model_input(DeploymentDockerOptionsUpdate, value)
        )
        update = DeploymentDockerOptionsUpdate.from_dict(fields)
    if update is None or not update.to_dict():
        raise ValueError("Pass at least one container option to update")
    return update


def _string_sequence(value: Sequence[str] | None, name: str) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        raise TypeError(f"{name} must be a sequence of strings, not one string")
    return list(value)


def _readiness_probe(value: DeploymentReadinessProbeInput | None) -> DeploymentReadinessProbe | None:
    if value is None or isinstance(value, DeploymentReadinessProbe):
        return value
    return DeploymentReadinessProbe.from_dict(_wire_model_input(DeploymentReadinessProbe, value))


def _deployment_identifier(identifier: str) -> str:
    identifier = identifier.strip()
    if not identifier:
        raise ValueError("Deployment identifier cannot be empty")
    return identifier


class _JobHandle:
    """Submission identity and receipt checks shared by sync and async handles."""

    def __init__(self, submission: WorkloadAdmissionResponse | str) -> None:
        self._deployment_targeted: bool | None = None
        self._submission_revision: int | None = None
        self._claim_deadline_at: float | None = None
        if isinstance(submission, WorkloadAdmissionResponse):
            self._id = submission.id
            self._submission: WorkloadAdmissionResponse | None = submission
            self._deployment_targeted = submission.submission_revision is not None
            self._accept_receipt(submission)
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

    def _accept_receipt(
        self, receipt: WorkloadAdmissionResponse | WorkloadResubmitResponse
    ) -> None:
        if self._deployment_targeted and receipt.submission_revision is None:
            raise ValueError("AnyCloud returned no Deployment submission revision")
        self._submission_revision = receipt.submission_revision
        self._claim_deadline_at = receipt.claim_deadline_at

    def _attach_status(self, status: WorkloadStatusResponse) -> None:
        if status.workload.workload_type != "job":
            raise ValueError(
                f"Workload {self.id!r} is a "
                f"{status.workload.workload_type!r}; only Job handles are supported"
            )
        self._last_status = status
        self._deployment_targeted = status.workload.deployment_id is not None
        self._submission_revision = status.workload.submission_revision

    def _claim_observed(self, observation: JobSubmissionObservation) -> bool:
        outcome = observation.outcome
        if outcome == JobSubmissionOutcome.CHANGED:
            raise JobSubmissionChanged(
                self, f"Job {self.id!r} has a newer submission"
            )
        if observation.submission_revision != self._submission_revision:
            raise ValueError("AnyCloud returned a different submission revision")
        if outcome == JobSubmissionOutcome.CLAIMED and observation.claimed:
            return True
        if outcome == JobSubmissionOutcome.EXPIRED:
            raise JobSubmissionExpired(
                self, f"Job {self.id!r} expired before its first claim"
            )
        if outcome == JobSubmissionOutcome.TERMINATED:
            raise JobSubmissionTerminated(
                self, f"Job {self.id!r} ended before its first claim"
            )
        if outcome != JobSubmissionOutcome.PENDING or observation.claimed:
            raise ValueError("AnyCloud returned an inconsistent claim observation")
        return False


_JobT = TypeVar("_JobT", bound=_JobHandle)


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


class _JobSubmissionResultError(Exception, Generic[_JobT]):
    """Retain the observed submission even when blocking submit returns no Job."""

    def __init__(self, job: _JobT, message: str) -> None:
        self.job = job
        self.workload_id = job.id
        self.revision = job._submission_revision
        super().__init__(message)


class JobSubmissionExpired(_JobSubmissionResultError[_JobT], TimeoutError):
    """The API confirmed this submission expired before its first claim."""


class JobSubmissionTerminated(_JobSubmissionResultError[_JobT], RuntimeError):
    """The submission ended before being claimed for a reason other than expiry."""


class JobSubmissionChanged(_JobSubmissionResultError[_JobT], RuntimeError):
    """The Job has been explicitly resubmitted since this handle's receipt."""


class JobSubmissionUncertain(RuntimeError, Generic[_JobT]):
    """Deployment submission failed without returning its otherwise unavailable handle.

    Keep :attr:`job` to inspect or wait for the submission; :attr:`cause` is the
    original request error. This exception does not confirm submission expiry.
    """

    def __init__(self, job: _JobT, cause: Exception) -> None:
        self.job = job
        self.cause = cause
        super().__init__(f"Submission of Job {job.id!r} is uncertain: {cause}")


def _submission_timeout(timeout: float | None) -> None:
    if timeout is not None and (not math.isfinite(timeout) or timeout < 0):
        raise ValueError("timeout must be finite and nonnegative")


def _submission_input(
    image: str | None,
    *,
    deployment: str | None,
    cloud_config: CloudConfigInput | None,
    credential_name: str | None,
    gpu: str | Sequence[str] | None,
    env: Mapping[str, str] | None,
    secrets: Sequence[str] | None,
    docker_options: DockerOptionsInput | None,
    command: Sequence[str] | None,
    workload_id: str | None,
    timeout: float | None,
    wait: bool,
) -> WorkloadAdmissionInputAnyOf | WorkloadAdmissionInputAnyOf1:
    if (image is None) == (deployment is None):
        raise ValueError("Exactly one of image or deployment is required")
    _submission_timeout(timeout)
    if deployment is None:
        if timeout is not None or wait:
            raise ValueError("timeout and wait require a Deployment-targeted submission")
        return WorkloadAdmissionInputAnyOf1(
            image=image,
            cloud_config=_cloud_config(cloud_config),
            credential_name=credential_name,
            gpu_type=(
                WorkloadAdmissionInputAnyOf1CloudConfigVmType(
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

    deployment = deployment.strip()
    if not deployment:
        raise ValueError("deployment cannot be empty")
    for name, value in (
        ("cloud_config", cloud_config),
        ("credential_name", credential_name),
        ("gpu", gpu),
        ("env", env),
        ("secrets", secrets),
        ("docker_options", docker_options),
        ("command", command),
    ):
        if value is not None:
            raise ValueError(
                f"{name} cannot be supplied with deployment; "
                "configure the Deployment instead"
            )
    return WorkloadAdmissionInputAnyOf(
        deployment=deployment,
        id=(
            f"job-{random_secrets.token_hex(12)}"
            if workload_id is None else workload_id.strip()
        ),
        workload_type="job",
        timeout=timeout,
    )


def _create_deployment_input(
    name: str,
    image: str,
    *,
    node_pool: str,
    command: Sequence[str] | None,
    env: Mapping[str, str] | None,
    docker_options: DockerOptionsInput | None,
    max_concurrent_jobs_per_replica: int,
    readiness_probe: DeploymentReadinessProbeInput | None = None,
    secrets: Sequence[str] | None = None,
    replicas: int | None = None,
    min_replicas: int | None = None,
    max_replicas: int | None = None,
) -> CreateDeploymentInput:
    request = CreateDeploymentInput(
        name=name,
        image=image,
        node_pool=node_pool,
        command=_string_sequence(command, "command"),
        env=dict(env) if env is not None else None,
        secrets=_string_sequence(secrets, "secrets"),
        docker_options=_docker_options(docker_options),
        max_concurrent_jobs_per_replica=max_concurrent_jobs_per_replica,
        **_replica_bounds(replicas, min_replicas, max_replicas),
    )
    if readiness_probe is not None:
        request.readiness_probe = _readiness_probe(readiness_probe)
    return request


def _replica_bounds(replicas: Any, min_replicas: Any, max_replicas: Any) -> dict[str, Any]:
    """``replicas=N`` is shorthand for ``min_replicas=N, max_replicas=N``."""
    unset = (None, _UNSET)
    given = {
        key: value
        for key, value in (("min_replicas", min_replicas), ("max_replicas", max_replicas))
        if value not in unset
    }
    if replicas in unset:
        return given
    if given:
        raise ValueError("Pass replicas or min_replicas and max_replicas, not both")
    return {"min_replicas": replicas, "max_replicas": replicas}


def _update_deployment_input(
    *,
    image: str | _Unset,
    command: Sequence[str] | None | _Unset,
    env: Mapping[str, str] | None | _Unset,
    docker_options: DeploymentDockerOptionsUpdateInput | None | _Unset,
    max_concurrent_jobs_per_replica: int | _Unset,
    readiness_probe: DeploymentReadinessProbeInput | None | _Unset = _UNSET,
    secrets: Sequence[str] | None | _Unset = _UNSET,
    replicas: int | _Unset = _UNSET,
    min_replicas: int | _Unset = _UNSET,
    max_replicas: int | _Unset = _UNSET,
) -> UpdateDeploymentBody:
    fields: dict[str, Any] = {}
    for name, value in (
        ("image", image),
        ("max_concurrent_jobs_per_replica", max_concurrent_jobs_per_replica),
        *_replica_bounds(replicas, min_replicas, max_replicas).items(),
    ):
        if not isinstance(value, _Unset):
            if value is None:
                raise ValueError(f"{name} cannot be None")
            fields[name] = value
    if not isinstance(command, _Unset):
        fields["command"] = _string_sequence(command, "command")
    if not isinstance(env, _Unset):
        fields["env"] = dict(env) if env is not None else None
    if not isinstance(secrets, _Unset):
        fields["secrets"] = _string_sequence(secrets, "secrets")
    if not isinstance(docker_options, _Unset):
        fields["docker_options"] = _deployment_docker_options_update(docker_options)
    if not isinstance(readiness_probe, _Unset):
        fields["readiness_probe"] = _readiness_probe(readiness_probe)
    if not fields:
        raise ValueError("Pass at least one Deployment field to update")
    return UpdateDeploymentBody(**fields)


def _admission_rejected(job: _JobHandle, error: Exception) -> bool:
    return (
        job.submission is None
        and isinstance(error, ApiException)
        and error.status is not None
        and 400 <= error.status < 500
        and error.status != 408
    )


def _observation_body(
    submission_revision: int, request_timeout_seconds: float
) -> JobSubmissionObservationBody:
    # Leave transport and decoding time after a full pending observation.
    observation_seconds = min(20, min(request_timeout_seconds, 30) * 0.75)
    return JobSubmissionObservationBody(
        submission_revision=submission_revision,
        wait_ms=int(observation_seconds * 1000),
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
        self._deployments = DeploymentsApi(self._api_client)
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
        image: str | None = None,
        *,
        deployment: str | None = None,
        cloud_config: CloudConfigInput | None = None,
        credential_name: str | None = None,
        gpu: str | Sequence[str] | None = None,
        env: Mapping[str, str] | None = None,
        secrets: Sequence[str] | None = None,
        docker_options: DockerOptionsInput | None = None,
        command: Sequence[str] | None = None,
        workload_id: str | None = None,
        timeout: float | None = None,
        wait: bool = False,
    ) -> Job:
        """Submit an image or target a Deployment and return a Job handle.

        Deployment-targeted Jobs use the Deployment's container configuration, so
        image and container/compute options cannot accompany ``deployment``.
        For Deployments, ``timeout`` covers admission to first claim; ``wait=True``
        returns after that durable claim. Use ``job.wait()`` for completion.
        """

        self._ensure_open()
        submission_input = _submission_input(
            image,
            deployment=deployment,
            cloud_config=cloud_config,
            credential_name=credential_name,
            gpu=gpu,
            env=env,
            secrets=secrets,
            docker_options=docker_options,
            command=command,
            workload_id=workload_id,
            timeout=timeout,
            wait=wait,
        )
        request = WorkloadAdmissionInput(submission_input)
        if isinstance(submission_input, WorkloadAdmissionInputAnyOf):
            assert submission_input.id is not None
            job = Job(self, submission_input.id)
            job._deployment_targeted = True
            job._submission_revision = 0
            try:
                submission = request_with_deadline(
                    self._admission.submit_workload,
                    self._sdk_version,
                    request,
                    deadline=time.monotonic() + min(self._request_timeout_seconds, 30),
                )
                if submission.id != job.id:
                    raise ValueError("AnyCloud admission returned a different Job ID")
                job._submission = submission
                job._accept_receipt(submission)
                if wait:
                    job.wait_for_claim()
                return job
            except (JobSubmissionExpired, JobSubmissionTerminated, JobSubmissionChanged):
                raise
            except Exception as error:
                if _admission_rejected(job, error):
                    # Admission was rejected. After acknowledgement, errors
                    # still need to retain the otherwise unreturned handle.
                    raise
                raise JobSubmissionUncertain(job, error) from error

        submission = self._admission.submit_workload_sync(
            self._sdk_version,
            request,
            _request_timeout=self._request_timeout_seconds,
        )
        return Job(self, submission)

    def create_deployment(
        self,
        name: str,
        image: str,
        *,
        node_pool: str,
        command: Sequence[str] | None = None,
        env: Mapping[str, str] | None = None,
        secrets: Sequence[str] | None = None,
        docker_options: DockerOptionsInput | None = None,
        max_concurrent_jobs_per_replica: int = 1,
        replicas: int | None = None,
        min_replicas: int | None = None,
        max_replicas: int | None = None,
        readiness_probe: DeploymentReadinessProbeInput | None = None,
    ) -> DeploymentSummary:
        """Create a Kubernetes Deployment that accepts Jobs and return its generated summary."""

        self._ensure_open()
        request = _create_deployment_input(
            name,
            image,
            node_pool=node_pool,
            command=command,
            env=env,
            docker_options=docker_options,
            max_concurrent_jobs_per_replica=max_concurrent_jobs_per_replica,
            replicas=replicas,
            min_replicas=min_replicas,
            max_replicas=max_replicas,
            readiness_probe=readiness_probe,
            secrets=secrets,
        )
        return self._deployments.create_deployment_sync(
            self._sdk_version,
            request,
            _request_timeout=self._request_timeout_seconds,
        ).deployment

    def list_deployments(self, *, node_pool: str | None = None) -> list[DeploymentSummary]:
        """List Deployments, optionally filtered by node pool name or ID."""

        self._ensure_open()
        return self._deployments.list_deployments_sync(
            self._sdk_version,
            node_pool=node_pool,
            _request_timeout=self._request_timeout_seconds,
        ).deployments

    def get_deployment(self, identifier: str) -> DeploymentSummary:
        """Fetch a Deployment by name or ID and return its generated summary."""

        self._ensure_open()
        return self._deployments.get_deployment_sync(
            _deployment_identifier(identifier),
            self._sdk_version,
            _request_timeout=self._request_timeout_seconds,
        ).deployment

    def update_deployment(
        self,
        deployment: str,
        *,
        image: str | _Unset = _UNSET,
        command: Sequence[str] | None | _Unset = _UNSET,
        env: Mapping[str, str] | None | _Unset = _UNSET,
        secrets: Sequence[str] | None | _Unset = _UNSET,
        docker_options: DeploymentDockerOptionsUpdateInput | None | _Unset = _UNSET,
        max_concurrent_jobs_per_replica: int | _Unset = _UNSET,
        replicas: int | _Unset = _UNSET,
        min_replicas: int | _Unset = _UNSET,
        max_replicas: int | _Unset = _UNSET,
        readiness_probe: DeploymentReadinessProbeInput | None | _Unset = _UNSET,
    ) -> DeploymentSummary:
        """Update supplied fields; explicit None clears nullable settings.

        docker_options changes individual options, preserving omissions; None
        removes an option and arrays replace the whole list. command, env, secrets, and
        docker_options also accept None to clear the whole field. readiness_probe
        replaces the complete native exec probe; None removes it.
        """

        self._ensure_open()
        identifier = _deployment_identifier(deployment)
        request = _update_deployment_input(
            image=image,
            command=command,
            env=env,
            docker_options=docker_options,
            max_concurrent_jobs_per_replica=max_concurrent_jobs_per_replica,
            replicas=replicas,
            min_replicas=min_replicas,
            max_replicas=max_replicas,
            readiness_probe=readiness_probe,
            secrets=secrets,
        )
        return self._deployments.update_deployment_sync(
            identifier,
            self._sdk_version,
            request,
            _request_timeout=self._request_timeout_seconds,
        ).deployment

    def delete_deployment(self, deployment: str) -> DeploymentSummary:
        """Begin draining/deleting a Deployment and return its generated summary."""

        self._ensure_open()
        return self._deployments.delete_deployment_sync(
            _deployment_identifier(deployment),
            self._sdk_version,
            _request_timeout=self._request_timeout_seconds,
        ).deployment

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

    def _terminate(self, workload_id: str) -> MessageResponse:
        self._ensure_open()
        return self._workloads.terminate_workload_sync(
            workload_id,
            self._sdk_version,
            _request_timeout=self._request_timeout_seconds,
        )

    def _resubmit(
        self, workload_id: str, timeout: float | None
    ) -> WorkloadResubmitResponse:
        self._ensure_open()
        return request_with_deadline(
            self._workloads.resubmit_workload,
            workload_id,
            self._sdk_version,
            WorkloadResubmitBody(timeout=timeout),
            deadline=time.monotonic() + self._request_timeout_seconds,
        )

    def _observe_submission(
        self, workload_id: str, submission_revision: int
    ) -> JobSubmissionObservation:
        self._ensure_open()
        request_budget_seconds = min(self._request_timeout_seconds, 30)
        return request_with_deadline(
            self._workloads.observe_job_submission,
            workload_id,
            self._sdk_version,
            _observation_body(submission_revision, self._request_timeout_seconds),
            deadline=time.monotonic() + request_budget_seconds,
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

    def terminate(self) -> MessageResponse:
        """Schedule termination and return the generated response."""

        return self._client._terminate(self.id)

    def wait_for_claim(self) -> Job:
        """Wait for this submission's first durable claim, retaining request errors.

        Confirmed expiry, other pre-claim termination, and a changed submission
        raise distinct exceptions. An HTTP timeout confirms none of those.
        """

        self._client._ensure_open()
        if self._submission_revision is None or self._deployment_targeted is None:
            status = self.status()
            self._deployment_targeted = status.workload.deployment_id is not None
            if self._submission_revision is None:
                self._submission_revision = status.workload.submission_revision
        if not self._deployment_targeted:
            raise ValueError("wait_for_claim requires a Deployment-targeted Job")
        assert self._submission_revision is not None
        while True:
            observation = self._client._observe_submission(
                self.id, self._submission_revision
            )
            if self._claim_observed(observation):
                return self

    def resubmit(
        self, *, timeout: float | None = None, wait: bool = False
    ) -> WorkloadResubmitResponse:
        """Resubmit the same Job ID, replacing its optional first-claim deadline.

        Return the generated submission receipt. ``wait=True`` waits for a
        Deployment claim; the acknowledged revision is also retained for subsequent
        ``wait_for_claim()`` calls.
        """

        _submission_timeout(timeout)
        if wait:
            if self._deployment_targeted is None:
                self._deployment_targeted = self.status().workload.deployment_id is not None
            if not self._deployment_targeted:
                raise ValueError("wait requires a Deployment-targeted resubmission")
        response = self._client._resubmit(self.id, timeout)
        self._accept_receipt(response)
        self._last_status = None
        if wait:
            self.wait_for_claim()
        return response

    def __repr__(self) -> str:
        return f"Job({self.id!r})"
