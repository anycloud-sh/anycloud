"""Native async Job workflows over the generated API client."""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any, Callable, Coroutine, TypeVar

from anycloud.models.workload_admission_response import WorkloadAdmissionResponse
from anycloud.models.workload_resubmit_body import WorkloadResubmitBody
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.workload_status_response import WorkloadStatusResponse

from ._request_deadline import async_request_with_deadline
from .workloads import async_wait_for_terminal_workload
from .jobs import (
    CloudConfigInput,
    DockerOptionsInput,
    JobFailedError,
    _ClientBase,
    _JobHandle,
    _submission_input,
)

_T = TypeVar("_T")


class AsyncClient(_ClientBase):
    """Async Job workflows with the same inputs as Client.

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
        # elapsed budget, as resubmission does.
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
    ) -> AsyncJob:
        """Submit an image as a Job and return an AsyncJob handle.

        Use ``await job.wait()`` for completion. Task cancellation propagates
        unchanged; supply and save a Job ID before submission when recovery
        after local cancellation is needed.
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
        submission = await self._request(
            self._admission.submit_workload, self.sdk_version, request
        )
        return AsyncJob(self, submission)

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

    async def terminate(self) -> WorkloadResubmitResponse:
        """Request termination; the response does not confirm runtime cleanup."""
        return await self._client._request(
            self._client._workloads.terminate_workload,
            self.id,
            self._client.sdk_version,
        )

    async def resubmit(self) -> WorkloadResubmitResponse:
        """Explicitly resubmit the same Job and return the generated response."""
        response = await self._client._request(
            self._client._workloads.resubmit_workload,
            self.id,
            self._client.sdk_version,
            WorkloadResubmitBody(),
            budget_seconds=self._client._request_timeout_seconds,
        )
        self._last_status = None
        return response

    def __repr__(self) -> str:
        return f"AsyncJob({self.id!r})"
