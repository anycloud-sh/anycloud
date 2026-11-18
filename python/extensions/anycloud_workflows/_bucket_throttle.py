"""Ride out a cloud provider throttling a bucket read."""

from __future__ import annotations

import asyncio
import json
import random
import time

from anycloud import rest
from anycloud.api_client import ApiClient

# The API answers a throttled bucket call 503 BUCKET_THROTTLED with a
# Retry-After. A read repeats for about 30 seconds from the first such answer,
# backing off from 1 to 8 seconds with jitter, never sooner than Retry-After.
# Writes and other 503s, including API_RESTARTING, are returned unchanged.
_THROTTLE_BUDGET_SECONDS = 30.0
_THROTTLE_MAX_DELAY_SECONDS = 8.0
_READS = frozenset({"GET", "HEAD"})

# Test seams.
_clock = time.monotonic
_sleep = asyncio.sleep
_random = random.random


def _throttled(data: bytes | None) -> bool:
    try:
        body = json.loads(data or b"")
    except ValueError:
        return False
    return isinstance(body, dict) and body.get("code") == "BUCKET_THROTTLED"


def _retry_after_seconds(response: rest.RESTResponse) -> float:
    value = (response.headers.get("retry-after") or "").strip()
    return float(value) if value.isdigit() else 0.0


class ThrottleRetryingApiClient(ApiClient):
    """The generated client, retrying bucket reads the provider throttled."""

    async def call_api(
        self,
        method,
        url,
        header_params=None,
        body=None,
        post_params=None,
        _request_timeout=None,
    ) -> rest.RESTResponse:
        deadline: float | None = None
        retries = 0
        while True:
            response = await super().call_api(
                method, url, header_params, body, post_params, _request_timeout
            )
            if (
                method.upper() not in _READS
                or response.status != 503
                or not _throttled(await response.read())
            ):
                return response
            now = _clock()
            if deadline is None:
                deadline = now + _THROTTLE_BUDGET_SECONDS
            if now >= deadline:
                return response
            retries += 1
            ceiling = min(2.0 ** (retries - 1), _THROTTLE_MAX_DELAY_SECONDS)
            backoff = ceiling / 2 + _random() * ceiling / 2
            delay = max(backoff, _retry_after_seconds(response))
            await _sleep(min(delay, deadline - now))
