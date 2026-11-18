"""Elapsed HTTP deadlines for generated async requests and synchronous workflows."""

from __future__ import annotations

import asyncio
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
import time
from typing import Any, Callable, Coroutine, TypeVar

from anycloud.sync_helper import _get_sync_loop

T = TypeVar("T")
_CANCELLATION_SETTLE_SECONDS = 0.1
# A generated request may suppress cancellation. Keep it alive until cleanup
# finishes; it owns no workflow state and cannot initiate another API operation.
_unfinished_requests: set[asyncio.Task[Any]] = set()


class RequestDeadlineExceeded(TimeoutError):
    """The elapsed request budget ended without a confirmed result."""


class RequestUnanswered(RequestDeadlineExceeded):
    """The budget ended with no answer; the request may have been sent or still queued locally."""


@dataclass(frozen=True)
class _RequestFailure:
    # asyncio's concurrent-future bridge replaces some built-in exception
    # objects on Python 3.12. Carry failures as values to preserve their cause.
    error: Exception


def remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RequestDeadlineExceeded("AnyCloud request deadline exceeded")
    return remaining


def _request_finished(task: asyncio.Task[Any]) -> None:
    _unfinished_requests.discard(task)
    if not task.cancelled():
        task.exception()


async def _request(
    request: Callable[..., Coroutine[Any, Any, T]],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    deadline: float,
) -> T | _RequestFailure:
    remaining = remaining_seconds(deadline)
    task = asyncio.create_task(
        request(*args, **kwargs, _request_timeout=remaining)
    )
    _unfinished_requests.add(task)
    task.add_done_callback(_request_finished)
    try:
        done, _ = await asyncio.wait({task}, timeout=remaining)
        if not done:
            raise RequestUnanswered("AnyCloud request deadline exceeded")
        remaining_seconds(deadline)
        return task.result()
    except Exception as error:
        return _RequestFailure(error)
    finally:
        if not task.done():
            task.cancel()
            await asyncio.wait(
                {task},
                timeout=max(
                    0.0,
                    min(_CANCELLATION_SETTLE_SECONDS, deadline - time.monotonic()),
                ),
            )


async def async_request_with_deadline(
    request: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    deadline: float,
    **kwargs: Any,
) -> T:
    """Await one generated request on the caller's loop within an elapsed budget.

    Cancelling the caller cancels the request, with bounded cleanup. A late
    response cannot update a workflow handle or start another request.
    """
    result = await _request(request, args, kwargs, deadline)
    if isinstance(result, _RequestFailure):
        raise result.error
    return result


def request_with_deadline(
    request: Callable[..., Coroutine[Any, Any, T]],
    *args: Any,
    deadline: float,
    **kwargs: Any,
) -> T:
    """Run one generated async request within an absolute monotonic deadline.

    Body reads share the same budget as connection setup. Cancellation cleanup
    gets at most the remaining budget, capped at 100 ms, including on Python
    3.10 where ``wait_for`` can wait indefinitely for a coroutine that suppresses
    cancellation. The synchronous
    workflow owns all state transitions after this function returns.
    """
    remaining_seconds(deadline)
    future = asyncio.run_coroutine_threadsafe(
        _request(request, args, kwargs, deadline), _get_sync_loop()
    )
    try:
        result = future.result(timeout=remaining_seconds(deadline))
    except FutureTimeoutError as error:
        future.cancel()
        if isinstance(error, RequestDeadlineExceeded):
            raise
        raise RequestUnanswered("AnyCloud request deadline exceeded") from error
    except BaseException:
        future.cancel()
        raise
    if isinstance(result, _RequestFailure):
        raise result.error
    return result
