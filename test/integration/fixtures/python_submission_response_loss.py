"""Test-owned response loss after the production API has successfully replied."""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

import httpx


class LostResponseTransport(httpx.AsyncBaseTransport):
    def __init__(
        self,
        fault: Literal["admission", "observation"],
        *,
        job_id: str | None = None,
        submission_revision: int = 0,
        claimed_only: bool = False,
        checkpoint_directory: Path | None = None,
        checkpoint_timeout: float = 20,
        inner: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.inner = inner if inner is not None else httpx.AsyncHTTPTransport()
        self.fault = fault
        self.job_id = job_id
        self.submission_revision = submission_revision
        self.claimed_only = claimed_only
        self.checkpoint_directory = checkpoint_directory
        self.checkpoint_timeout = checkpoint_timeout
        self.capture: dict[str, object] | None = None
        self.injected_error: httpx.ReadError | None = None
        self.losses = 0
        self.admissions = 0
        self.resubmissions = 0
        self.observations: list[dict[str, object]] = []
        self.closed = False

    @property
    def lost(self) -> bool:
        return self.injected_error is not None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        admission = request.method == "POST" and path == "/v1/workloads"
        observation = (
            re.fullmatch(r"/v1/workloads/([^/]+)/claim-observation", path)
            if request.method == "POST"
            else None
        )
        selected = False
        if admission:
            self.admissions += 1
            body = json.loads(request.content)
            if self.job_id is None:
                self.job_id = body["id"]
            selected = self.fault == "admission" and body["id"] == self.job_id
        if request.method == "POST" and re.fullmatch(r"/v1/workloads/[^/]+/resubmit", path):
            self.resubmissions += 1
        if observation:
            body = json.loads(request.content)
            job_id = unquote(observation[1])
            self.observations.append(
                {
                    "jobId": job_id,
                    "submissionRevision": body["submissionRevision"],
                    "afterLoss": self.lost,
                }
            )
            selected = (
                self.fault == "observation"
                and job_id == self.job_id
                and body["submissionRevision"] == self.submission_revision
            )

        response = await self.inner.handle_async_request(request)
        if not selected or self.capture is not None or not response.is_success:
            return response
        try:
            body = json.loads(await response.aread())
            if observation and self.claimed_only and body["outcome"] != "claimed":
                return response
            assert body["submissionRevision"] == self.submission_revision
            if admission:
                assert body["id"] == self.job_id
            elif self.claimed_only:
                assert body["claimed"] is True
            self.capture = {
                "fault": self.fault,
                "jobId": self.job_id,
                "submissionRevision": body["submissionRevision"],
                "method": request.method,
                "path": path,
                "statusCode": response.status_code,
                "outcome": "admitted" if admission else body["outcome"],
            }
        except BaseException:
            await response.aclose()
            raise
        await response.aclose()
        print("RESPONSE_CAPTURED " + json.dumps(self.capture), file=sys.stderr, flush=True)
        if self.checkpoint_directory is not None:
            temporary = self.checkpoint_directory / "captured.tmp"
            temporary.write_text(json.dumps(self.capture), encoding="utf-8")
            temporary.replace(self.checkpoint_directory / "captured.json")
            await self._wait_for_release()
        self.injected_error = httpx.ReadError("committed response lost", request=request)
        self.losses += 1
        raise self.injected_error

    async def _wait_for_release(self) -> None:
        assert self.checkpoint_directory is not None
        deadline = time.monotonic() + self.checkpoint_timeout
        while time.monotonic() < deadline:
            if (self.checkpoint_directory / "abort").exists():
                raise RuntimeError("response-loss checkpoint aborted")
            if (self.checkpoint_directory / "release").exists():
                return
            # Poll a published condition; elapsed time never releases the fault.
            await asyncio.sleep(0.01)
        raise TimeoutError("response-loss checkpoint was not released")

    async def aclose(self) -> None:
        await self.inner.aclose()
        self.closed = True
