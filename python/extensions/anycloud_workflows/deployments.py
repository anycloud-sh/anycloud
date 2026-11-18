"""Current-Deployment helpers built on generated workload operations."""

from __future__ import annotations

import math
import os
import time
from pathlib import Path
from typing import Callable, Literal, TypeVar

import httpx

from anycloud.api.deployment_workload_api import DeploymentWorkloadApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration
from anycloud.exceptions import ApiException
from anycloud.models.selected_job import SelectedJob
from anycloud.models.workload_cleanup_body import WorkloadCleanupBody
from anycloud.models.workload_outcome_body import WorkloadOutcomeBody
from anycloud.sync_helper import run_sync

from ._request_deadline import (
    RequestUnanswered,
    remaining_seconds,
    request_with_deadline,
)
from .deployment_jobs import DeploymentJobPoller

DeploymentJobOutcome = Literal["completed", "errored", "invalid", "retryable"]
T = TypeVar("T")
# An API upgrade replaces its Pod: ride out about two minutes of 502/503/504s,
# Cloudflare's 520–523 and lost connections, backing off from 0.5 to 5 seconds.
_RESTART_STATUSES = frozenset({502, 503, 504, 520, 521, 522, 523})
_RESTART_BUDGET_SECONDS = 120.0


def _ride_out_restart(call: Callable[[], T], unanswered: bool = False) -> T:
    """Repeat a replayable workload operation while the API restarts.

    With ``unanswered``, a request that got no answer within its own budget is
    a restart too: a Job poll stranded at the edge while no Pod serves. Other
    waits keep failing at their deadline (a saturated local connection pool
    looks the same and is not a restart).
    """

    deadline = time.monotonic() + _RESTART_BUDGET_SECONDS
    delay = 0.5
    while True:
        try:
            return call()
        except (ApiException, httpx.TransportError, RequestUnanswered) as error:
            if isinstance(error, RequestUnanswered) and not unanswered:
                raise
            if isinstance(error, ApiException) and error.status not in _RESTART_STATUSES:
                raise
            if time.monotonic() + delay > deadline:
                raise
        time.sleep(delay)
        delay = min(delay * 2, 5.0)


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required inside a Kubernetes Deployment")
    return value


class DeploymentContext:
    """Generated workload operations scoped to the current Deployment process."""

    def __init__(
        self,
        *,
        api_url: str,
        deployment_id: str,
        token_file: str | os.PathLike[str],
        timeout_seconds: float = 30.0,
    ) -> None:
        if not api_url.strip():
            raise ValueError("api_url cannot be empty")
        if not deployment_id.strip():
            raise ValueError("deployment_id cannot be empty")
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be finite and greater than zero")

        self._deployment_id = deployment_id.strip()
        self._token_file = Path(token_file)
        self._timeout_seconds = timeout_seconds
        self._configuration = Configuration(
            host=f"{api_url.strip().rstrip('/')}/v1"
        )
        self._client = ApiClient(self._configuration)
        self._api = DeploymentWorkloadApi(self._client)
        # Held cancellation requests must not exhaust lifecycle connections.
        self._wait_client = ApiClient(self._configuration)
        self._wait_api = DeploymentWorkloadApi(self._wait_client)
        self._jobs = DeploymentJobPoller(
            self._client,
            self._deployment_id,
            request_timeout_seconds=timeout_seconds,
        )
        self._closed = False

    def __enter__(self) -> DeploymentContext:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        """Close both generated API clients owned by this context."""

        if self._closed:
            return
        try:
            run_sync(self._client.close())
        finally:
            try:
                run_sync(self._wait_client.close())
            finally:
                self._closed = True

    def next_job(self, timeout: float = 20) -> CurrentJob | None:
        """Wait for a claimed Job, or return ``None`` with no unresolved claim.

        Keep this context for retries after an uncertain request failure.
        ``timeout`` defaults to twenty seconds; zero performs an immediate
        lookup.
        """

        def attempt() -> SelectedJob | None:
            # Each attempt has its own budget; a pending claim keeps its
            # execution ID, so a retry resumes it rather than claiming again.
            request_deadline, wait_deadline = self._jobs._deadlines(timeout)
            self._refresh_token()
            remaining_seconds(request_deadline)
            return self._jobs._next_job(timeout, request_deadline, wait_deadline)

        selected = _ride_out_restart(attempt, unanswered=True)
        return CurrentJob(self, selected) if selected is not None else None

    def cancellation_requested(
        self, job: SelectedJob | CurrentJob, timeout: float = 0
    ) -> bool:
        """Observe termination, optionally waiting up to twenty seconds.

        Zero checks immediately. Completion, retry, and wait expiry return
        ``False``; identity and transport errors propagate to the caller.
        """

        if not math.isfinite(timeout) or not 0 <= timeout <= 20:
            raise ValueError("timeout must be finite and between 0 and 20 seconds")
        selected = job.selected if isinstance(job, CurrentJob) else job
        api = self._wait_api if timeout > 0 else self._api

        def attempt() -> bool:
            started = time.monotonic()
            deadline = started + min(self._timeout_seconds, 30.0)
            self._refresh_token()
            return request_with_deadline(
                api.get_deployment_job_cancellation,
                self._deployment_id,
                selected.job_id,
                selected.execution_id,
                wait_ms=max(0, int((started + timeout - time.monotonic()) * 1000)),
                deadline=deadline,
            ).cancelled

        return _ride_out_restart(attempt)

    def outcome(
        self,
        job: SelectedJob | CurrentJob,
        outcome: DeploymentJobOutcome,
        message: str | None = None,
    ) -> None:
        """Publish the outcome of this Job execution."""

        selected = job.selected if isinstance(job, CurrentJob) else job
        self._retry(lambda: self._api.report_deployment_job_outcome_sync(
            self._deployment_id,
            selected.job_id,
            WorkloadOutcomeBody(
                executionId=selected.execution_id,
                outcome=outcome,
                message=message,
            ),
            _request_timeout=self._timeout_seconds,
        ))

    def cleanup(self, job: SelectedJob | CurrentJob) -> None:
        """Confirm that a terminated local task has stopped."""

        selected = job.selected if isinstance(job, CurrentJob) else job
        self._retry(lambda: self._api.cleanup_deployment_job_sync(
            self._deployment_id,
            selected.job_id,
            WorkloadCleanupBody(executionId=selected.execution_id),
            _request_timeout=self._timeout_seconds,
        ))

    def _retry(self, call: Callable[[], T]) -> T:
        def attempt() -> T:
            self._refresh_token()
            return call()

        return _ride_out_restart(attempt)

    def _refresh_token(self) -> None:
        try:
            token = self._token_file.read_text(encoding="utf8").strip()
        except OSError as error:
            raise ValueError(
                f"Could not read workload token file {self._token_file}"
            ) from error
        if not token:
            raise ValueError("Workload token file is empty")
        self._configuration.access_token = token


class CurrentJob:
    """A running Job with lifecycle operations bound to its Deployment context.

    Keep the owning context open while handling the Job. The original generated
    response remains available through :attr:`selected`.
    """

    def __init__(self, deployment: DeploymentContext, selected: SelectedJob) -> None:
        self._deployment = deployment
        self._selected = selected

    @property
    def id(self) -> str:
        """Return the Job ID used by the application."""

        return self._selected.job_id

    @property
    def selected(self) -> SelectedJob:
        """Return the original generated selection response."""

        return self._selected

    def complete(self) -> None:
        """Publish successful completion of this Job execution."""

        self._deployment.outcome(self._selected, "completed")

    def error(self, message: str) -> None:
        """Publish an application error for this Job execution."""

        self._deployment.outcome(self._selected, "errored", message)

    def invalid(self, message: str) -> None:
        """Reject this Job as invalid without retrying it."""

        self._deployment.outcome(self._selected, "invalid", message)

    def retry(self, message: str) -> None:
        """Report a retryable failure for the API to reschedule."""

        self._deployment.outcome(self._selected, "retryable", message)

    def cancellation_requested(self, timeout: float = 0) -> bool:
        """Observe termination, optionally waiting up to twenty seconds."""

        return self._deployment.cancellation_requested(self._selected, timeout=timeout)

    def cleanup(self) -> None:
        """Confirm that this terminated local task has stopped."""

        self._deployment.cleanup(self._selected)

    def __repr__(self) -> str:
        return f"CurrentJob({self.id!r})"


def current_deployment(*, timeout_seconds: float = 30.0) -> DeploymentContext:
    """Construct the current Deployment context from injected Pod identity."""

    return DeploymentContext(
        api_url=_required_environment("ANYCLOUD_API_URL"),
        deployment_id=_required_environment("ANYCLOUD_DEPLOYMENT_ID"),
        token_file=_required_environment("ANYCLOUD_WORKLOAD_TOKEN_FILE"),
        timeout_seconds=timeout_seconds,
    )
