"""Native async Job workflows over the generated API client."""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any, Callable, Coroutine, TypeVar

from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_admission_input_any_of import WorkloadAdmissionInputAnyOf
from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_body import WorkloadResubmitBody
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.message_response import MessageResponse
from anycloud.models.deployment_summary import DeploymentSummary

from ._request_deadline import async_request_with_deadline
from .workloads import async_wait_for_terminal_workload
from .jobs import (
    CloudConfigInput,
    DockerOptionsInput,
    JobFailedError,
    JobSubmissionChanged,
    JobSubmissionExpired,
    JobSubmissionTerminated,
    JobSubmissionUncertain,
    DeploymentDockerOptionsUpdateInput,
    _ClientBase,
    _JobHandle,
    _UNSET,
    _Unset,
    DeploymentReadinessProbeInput,
    _admission_rejected,
    _create_deployment_input,
    _observation_body,
    _submission_input,
    _submission_timeout,
    _update_deployment_input,
    _deployment_identifier,
)

_T = TypeVar("_T")


class AsyncClient(_ClientBase):
    """Async Job and Deployment management workflows with the same inputs as Client.

    Use one instance within an event loop, and keep it open while its requests
    and Job handles are in use. Other operations remain available through the
    owned generated ``api_client``.
    """

    async def __aenter__(self) -> AsyncClient:
        self._ensure_open()
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the generated API client's connections on the caller's loop."""
        if not self._closed:
            await self._api_client.close()
            self._closed = True

    async def _request(
        self,
        request: Callable[..., Coroutine[Any, Any, _T]],
        *args: Any,
        budget_seconds: float | None = None,
        **kwargs: Any,
    ) -> _T:
        self._ensure_open()
        # Match Client's transport timeout unless the operation requires an
        # elapsed budget, as Deployment claim workflows and resubmission do.
        if budget_seconds is None:
            return await request(
                *args, **kwargs, _request_timeout=self._request_timeout_seconds
            )
        return await async_request_with_deadline(
            request,
            *args,
            deadline=time.monotonic() + budget_seconds,
            **kwargs,
        )

    async def submit(
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
    ) -> AsyncJob:
        """Submit an image or target a Deployment and return an AsyncJob handle.

        Deployment submissions reject container and compute overrides. For Deployments,
        ``timeout`` is the server's admission-to-first-claim deadline and
        ``wait=True`` returns after claim. Use ``await job.wait()`` for completion.
        Deployment expiry, pre-claim termination, changed submissions, and uncertainty
        use the same exceptions as Client, carrying an AsyncJob recovery handle.
        Task cancellation propagates unchanged; supply and save a Job ID before
        submission when recovery after local cancellation is needed.
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
        if not isinstance(submission_input, WorkloadAdmissionInputAnyOf):
            submission = await self._request(
                self._admission.submit_workload, self.sdk_version, request
            )
            return AsyncJob(self, submission)

        assert submission_input.id is not None
        job = AsyncJob(self, submission_input.id)
        job._deployment_targeted = True
        job._submission_revision = 0
        try:
            submission = await self._request(
                self._admission.submit_workload,
                self.sdk_version,
                request,
                budget_seconds=min(self._request_timeout_seconds, 30),
            )
            if submission.id != job.id:
                raise ValueError("AnyCloud admission returned a different Job ID")
            job._submission = submission
            job._accept_receipt(submission)
            if wait:
                await job.wait_for_claim()
            return job
        except (JobSubmissionExpired, JobSubmissionTerminated, JobSubmissionChanged):
            raise
        except Exception as error:
            if _admission_rejected(job, error):
                raise
            raise JobSubmissionUncertain(job, error) from error

    async def create_deployment(
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
        return (
            await self._request(self._deployments.create_deployment, self.sdk_version, request)
        ).deployment

    async def list_deployments(self, *, node_pool: str | None = None) -> list[DeploymentSummary]:
        """List Deployments, optionally filtered by node pool name or ID."""
        return (
            await self._request(
                self._deployments.list_deployments, self.sdk_version, node_pool=node_pool
            )
        ).deployments

    async def get_deployment(self, identifier: str) -> DeploymentSummary:
        """Fetch a Deployment by name or ID and return its generated summary."""
        self._ensure_open()
        return (
            await self._request(
                self._deployments.get_deployment, _deployment_identifier(identifier), self.sdk_version
            )
        ).deployment

    async def update_deployment(
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

        Docker options preserve omitted settings; None removes an option and
        arrays replace the whole list. command, env, secrets, and docker_options also
        accept None to clear the whole field. readiness_probe replaces the
        complete native exec probe; None removes it.
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
        return (
            await self._request(
                self._deployments.update_deployment, identifier, self.sdk_version, request
            )
        ).deployment

    async def delete_deployment(self, deployment: str) -> DeploymentSummary:
        """Begin draining/deleting a Deployment and return its generated summary."""
        self._ensure_open()
        return (
            await self._request(
                self._deployments.delete_deployment, _deployment_identifier(deployment), self.sdk_version
            )
        ).deployment

    async def get(self, workload_id: str) -> AsyncJob:
        """Reattach to a Job by ID and fetch its current generated status."""
        self._ensure_open()
        workload_id = workload_id.strip()
        if not workload_id:
            raise ValueError("Job identifier cannot be empty")
        job = AsyncJob(self, workload_id)
        job._attach_status(await job.status())
        return job


class AsyncJob(_JobHandle):
    """A Job handle whose network operations run on the caller's event loop."""

    def __init__(
        self, client: AsyncClient, submission: WorkloadAdmissionResponse | str
    ) -> None:
        super().__init__(submission)
        self._client = client

    async def status(self) -> WorkloadStatusResponse:
        """Fetch current Job status without changing this submission's receipt."""
        self._last_status = await self._client._request(
            self._client._workloads.get_workload_status,
            self.id,
            self._client.sdk_version,
        )
        return self._last_status

    async def wait(
        self,
        *,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float = 2.0,
    ) -> AsyncJob:
        """Wait for successful completion and return this handle.

        Unsuccessful terminal states raise JobFailedError. WorkloadWaitTimeout
        or task cancellation stops polling without terminating the Job.
        """
        self._client._ensure_open()
        self._last_status = await async_wait_for_terminal_workload(
            self._client.api_client,
            self.id,
            self._client.sdk_version,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )
        if self._last_status.workload.state != "completed":
            raise JobFailedError(self._last_status)
        return self

    async def wait_for_claim(self) -> AsyncJob:
        """Await claim of this submission, preserving errors on this known handle."""
        self._client._ensure_open()
        if self._submission_revision is None or self._deployment_targeted is None:
            status = await self.status()
            self._deployment_targeted = status.workload.deployment_id is not None
            if self._submission_revision is None:
                self._submission_revision = status.workload.submission_revision
        if not self._deployment_targeted:
            raise ValueError("wait_for_claim requires a Deployment-targeted Job")
        assert self._submission_revision is not None
        while True:
            observation = await self._client._request(
                self._client._workloads.observe_job_submission,
                self.id,
                self._client.sdk_version,
                _observation_body(
                    self._submission_revision, self._client._request_timeout_seconds
                ),
                budget_seconds=min(self._client._request_timeout_seconds, 30),
            )
            if self._claim_observed(observation):
                return self

    async def terminate(self) -> MessageResponse:
        """Request termination; the response does not confirm runtime cleanup."""
        return await self._client._request(
            self._client._workloads.terminate_workload,
            self.id,
            self._client.sdk_version,
        )

    async def resubmit(
        self, *, timeout: float | None = None, wait: bool = False
    ) -> WorkloadResubmitResponse:
        """Explicitly resubmit the same Job and optionally await the new claim."""
        _submission_timeout(timeout)
        if wait:
            if self._deployment_targeted is None:
                self._deployment_targeted = (
                    await self.status()
                ).workload.deployment_id is not None
            if not self._deployment_targeted:
                raise ValueError("wait requires a Deployment-targeted resubmission")
        response = await self._client._request(
            self._client._workloads.resubmit_workload,
            self.id,
            self._client.sdk_version,
            WorkloadResubmitBody(timeout=timeout),
            budget_seconds=self._client._request_timeout_seconds,
        )
        self._accept_receipt(response)
        self._last_status = None
        if wait:
            await self.wait_for_claim()
        return response

    def __repr__(self) -> str:
        return f"AsyncJob({self.id!r})"
