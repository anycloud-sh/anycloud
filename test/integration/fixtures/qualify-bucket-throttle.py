"""The workflow client rides out a throttled bucket read, and nothing else."""

from __future__ import annotations

from unittest.mock import patch

import httpx
from anycloud.api.buckets_api import BucketsApi
from anycloud.exceptions import ServiceException
import anycloud_workflows._bucket_throttle as bucket_throttle
from anycloud_workflows import Client


def throttled(retry_after: str | None = None) -> httpx.Response:
    return httpx.Response(
        503,
        headers={} if retry_after is None else {"Retry-After": retry_after},
        json={"defined": True, "code": "BUCKET_THROTTLED", "status": 503, "message": "Azure throttled"},
    )


LISTED = httpx.Response(200, json={"buckets": [], "nextCursor": None})
RESTARTING = httpx.Response(
    503,
    headers={"Retry-After": "1"},
    json={"defined": True, "code": "API_RESTARTING", "status": 503, "message": "API server is restarting"},
)


def exercise(responses: list[httpx.Response], call) -> tuple[object, list[httpx.Request], list[float]]:
    """Answer each request with the next response; a fake clock moves only by the waits."""

    requests: list[httpx.Request] = []
    waits: list[float] = []
    now = [100.0]

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return responses[min(len(requests), len(responses)) - 1]

    async def sleep(seconds: float) -> None:
        waits.append(seconds)
        now[0] += seconds

    with (
        Client(api_url="https://api.example.test", token="token") as client,
        patch.object(bucket_throttle, "_clock", lambda: now[0]),
        patch.object(bucket_throttle, "_sleep", sleep),
        patch.object(bucket_throttle, "_random", lambda: 0.0),
    ):
        client.api_client.rest_client.pool_manager = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        buckets = BucketsApi(client.api_client)
        try:
            outcome: object = call(buckets, client.sdk_version)
        except ServiceException as error:
            outcome = error
    return outcome, requests, waits


def list_buckets(buckets: BucketsApi, version: str) -> object:
    return buckets.list_buckets_sync("prod", version)


def qualify_retry_after_and_backoff() -> None:
    # Retry-After is a floor over the backoff; an invalid one leaves the backoff.
    page, requests, waits = exercise(
        [throttled("3"), throttled("soon"), throttled(), LISTED], list_buckets
    )
    assert page.buckets == [], page
    assert len(requests) == 4
    assert waits == [3.0, 1.0, 2.0], waits


def qualify_budget_exhausted() -> None:
    error, requests, waits = exercise([throttled("20")], list_buckets)
    assert isinstance(error, ServiceException) and error.status == 503, error
    assert error.data.actual_instance.code == "BUCKET_THROTTLED"
    # 20 s, then the last 10 s of the 30 s budget, then the throttled answer.
    assert waits == [20.0, 10.0], waits
    assert len(requests) == 3


def qualify_backoff_cap() -> None:
    error, requests, waits = exercise([throttled()], list_buckets)
    assert isinstance(error, ServiceException), error
    # Steps up to 8 s at the jitter floor, then the rest of the 30 s budget.
    assert waits == [0.5, 1.0, 2.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 2.5], waits
    assert len(requests) == 11


def qualify_writes_and_other_503s_unchanged() -> None:
    for call, response in (
        (lambda buckets, version: buckets.delete_bucket_sync("prod", "b", version), throttled()),
        (list_buckets, RESTARTING),
    ):
        error, requests, waits = exercise([response, LISTED], call)
        assert isinstance(error, ServiceException) and error.status == 503, error
        assert (len(requests), waits) == (1, []), (requests, waits)


if __name__ == "__main__":
    qualify_retry_after_and_backoff()
    qualify_budget_exhausted()
    qualify_backoff_cap()
    qualify_writes_and_other_503s_unchanged()
