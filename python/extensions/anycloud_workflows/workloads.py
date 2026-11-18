"""Workload workflow helpers built on generated API operations."""

from __future__ import annotations

import asyncio
import time
from typing import Final

from anycloud.api.workloads_api import WorkloadsApi
from anycloud.api_client import ApiClient
from anycloud.models.workload_status_response import WorkloadStatusResponse

TERMINAL_WORKLOAD_STATES: Final = frozenset(
    {"completed", "errored", "failed", "invalid", "terminated"}
)


class WorkloadWaitTimeout(TimeoutError):
    """Raised when a workload remains nonterminal past the requested timeout."""


def _wait_deadline(
    timeout_seconds: float | None, poll_interval_seconds: float
) -> float | None:
    if timeout_seconds is not None and timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be greater than zero")
    if poll_interval_seconds <= 0:
        raise ValueError("poll_interval_seconds must be greater than zero")
    return time.monotonic() + timeout_seconds if timeout_seconds is not None else None


def _remaining_wait_seconds(
    workload_id: str, timeout_seconds: float | None, deadline: float | None
) -> float | None:
    if deadline is None:
        return None
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise WorkloadWaitTimeout(
            f"Workload {workload_id!r} did not reach a terminal state "
            f"within {timeout_seconds:g} seconds"
        )
    return remaining


def wait_for_terminal_workload(
    client: ApiClient,
    workload_id: str,
    any_cloud_client_version: str,
    *,
    timeout_seconds: float | None,
    poll_interval_seconds: float = 2.0,
) -> WorkloadStatusResponse:
    """Return generated status once a workload reaches a terminal state.

    The caller owns the generated client and its authentication. This helper
    only composes generated status calls; API errors propagate unchanged.
    ``None`` waits without a deadline.
    """

    deadline = _wait_deadline(timeout_seconds, poll_interval_seconds)
    workloads = WorkloadsApi(client)
    while True:
        remaining_seconds = _remaining_wait_seconds(
            workload_id, timeout_seconds, deadline
        )
        status = workloads.get_workload_status_sync(
            workload_id,
            any_cloud_client_version,
            _request_timeout=remaining_seconds,
        )
        if status.workload.state in TERMINAL_WORKLOAD_STATES:
            return status

        remaining_seconds = _remaining_wait_seconds(
            workload_id, timeout_seconds, deadline
        )
        time.sleep(
            poll_interval_seconds
            if remaining_seconds is None
            else min(poll_interval_seconds, remaining_seconds)
        )


async def async_wait_for_terminal_workload(
    client: ApiClient,
    workload_id: str,
    any_cloud_client_version: str,
    *,
    timeout_seconds: float | None,
    poll_interval_seconds: float = 2.0,
) -> WorkloadStatusResponse:
    """Await a terminal workload using the caller-owned generated client.

    Like wait_for_terminal_workload, this helper passes the remaining wait
    budget to each status request and propagates API/transport errors unchanged.
    ``None`` waits without a deadline. Cancellation stops observation without
    terminating the workload or closing the caller's client.
    """
    deadline = _wait_deadline(timeout_seconds, poll_interval_seconds)
    workloads = WorkloadsApi(client)
    while True:
        remaining_seconds = _remaining_wait_seconds(
            workload_id, timeout_seconds, deadline
        )
        status = await workloads.get_workload_status(
            workload_id,
            any_cloud_client_version,
            _request_timeout=remaining_seconds,
        )
        if status.workload.state in TERMINAL_WORKLOAD_STATES:
            return status

        remaining_seconds = _remaining_wait_seconds(
            workload_id, timeout_seconds, deadline
        )
        await asyncio.sleep(
            poll_interval_seconds
            if remaining_seconds is None
            else min(poll_interval_seconds, remaining_seconds)
        )
