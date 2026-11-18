"""Read-only discovery followed by an exact, replayable Deployment Job claim."""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from uuid import UUID, uuid4

from anycloud.api.deployment_workload_api import DeploymentWorkloadApi
from anycloud.api_client import ApiClient
from anycloud.exceptions import ApiException
from anycloud.models.get_deployment_job_cancellation409_response import (
    GetDeploymentJobCancellation409Response,
)
from anycloud.models.selected_job import SelectedJob
from anycloud.models.workload_candidate_stale_api_error import WorkloadCandidateStaleApiError
from anycloud.models.workload_claim_job_body import WorkloadClaimJobBody
from anycloud.models.workload_execution_used_api_error import WorkloadExecutionUsedApiError

from ._request_deadline import (
    RequestDeadlineExceeded,
    remaining_seconds,
    request_with_deadline,
)


@dataclass(frozen=True)
class _PendingClaim:
    execution_id: UUID
    job_id: str
    submission_revision: int
    previous_execution_id: UUID | None


class DeploymentJobPoller:
    """Discover and claim Jobs, retaining exact claim identity on uncertainty.

    Keep the poller alive across retries. ``None`` means no unresolved claim
    from this call can assign work later. An exception may leave a pending
    claim; the next call resolves that same candidate before looking elsewhere.
    """

    def __init__(
        self,
        client: ApiClient,
        deployment_id: str,
        *,
        request_timeout_seconds: float | None = None,
    ) -> None:
        if request_timeout_seconds is not None and (
            not math.isfinite(request_timeout_seconds)
            or request_timeout_seconds <= 0
        ):
            raise ValueError(
                "request_timeout_seconds must be finite and greater than zero"
            )
        self._api = DeploymentWorkloadApi(client)
        self._deployment_id = deployment_id
        self._lock = threading.Lock()
        self._pending: _PendingClaim | None = None
        self._request_timeout_seconds = min(request_timeout_seconds or 30.0, 30.0)

    def _deadlines(self, timeout: float) -> tuple[float, float]:
        if not math.isfinite(timeout) or not 0 <= timeout <= 20:
            raise ValueError("timeout must be finite and between 0 and 20 seconds")
        started = time.monotonic()
        return started + self._request_timeout_seconds, started + timeout

    def next_job(self, timeout: float = 20) -> SelectedJob | None:
        """Wait up to ``timeout`` seconds to discover and claim one Job.

        ``timeout`` defaults to twenty seconds. ``timeout=0`` performs one
        lookup and at most one new claim. Request failures retain an attempted
        claim for an exact retry.
        """

        request_deadline, wait_deadline = self._deadlines(timeout)
        return self._next_job(timeout, request_deadline, wait_deadline)

    def _next_job(
        self, timeout: float, request_deadline: float, wait_deadline: float
    ) -> SelectedJob | None:
        if not self._lock.acquire(timeout=remaining_seconds(request_deadline)):
            raise RequestDeadlineExceeded("Deployment Job acquisition lock timed out")
        try:
            while True:
                remaining_seconds(request_deadline)
                if self._pending is None:
                    if timeout > 0 and time.monotonic() >= wait_deadline:
                        return None
                    candidate = request_with_deadline(
                        self._api.discover_deployment_job_candidate,
                        self._deployment_id,
                        wait_ms=(
                            max(0, int((wait_deadline - time.monotonic()) * 1000))
                            if timeout > 0 else 0
                        ),
                        deadline=request_deadline,
                    )
                    remaining_seconds(request_deadline)
                    if candidate is None or (
                        timeout > 0 and time.monotonic() >= wait_deadline
                    ):
                        return None
                    pending = _PendingClaim(
                        execution_id=uuid4(),
                        job_id=candidate.job_id,
                        submission_revision=candidate.submission_revision,
                        previous_execution_id=candidate.previous_execution_id,
                    )
                    remaining_seconds(request_deadline)
                    if timeout > 0 and time.monotonic() >= wait_deadline:
                        return None
                    self._pending = pending

                pending = self._pending
                try:
                    selected = request_with_deadline(
                        self._api.claim_deployment_job,
                        self._deployment_id,
                        pending.job_id,
                        pending.execution_id,
                        WorkloadClaimJobBody(
                            submission_revision=pending.submission_revision,
                            previous_execution_id=pending.previous_execution_id,
                        ),
                        deadline=request_deadline,
                    )
                except ApiException as error:
                    if error.status != 409 or not isinstance(
                        error.data, GetDeploymentJobCancellation409Response
                    ):
                        raise
                    conflict = error.data.actual_instance
                    if isinstance(conflict, WorkloadExecutionUsedApiError):
                        self._pending = None
                        raise
                    if not isinstance(conflict, WorkloadCandidateStaleApiError):
                        raise
                    self._pending = None
                    remaining = remaining_seconds(request_deadline)
                    wait_remaining = wait_deadline - time.monotonic()
                    if timeout == 0 or wait_remaining <= 0:
                        return None
                    time.sleep(min(0.1, remaining, wait_remaining))
                    continue

                remaining_seconds(request_deadline)
                if selected is None or selected.job_id != pending.job_id:
                    raise ValueError("AnyCloud workload API returned a different Job ID")
                if selected.execution_id != pending.execution_id:
                    raise ValueError("AnyCloud workload API returned a different execution ID")
                self._pending = None
                return selected
        finally:
            self._lock.release()
