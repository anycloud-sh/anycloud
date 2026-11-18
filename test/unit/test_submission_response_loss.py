"""Negative controls for the test-owned submission response-loss transport."""

import asyncio
import runpy
from pathlib import Path

import httpx
import pytest


def response_loss_transport(fault, handler, **options):
    helper = Path(__file__).resolve().parents[1] / "integration/fixtures/python_submission_response_loss.py"
    transport_type = runpy.run_path(str(helper))["LostResponseTransport"]
    return transport_type(fault, inner=httpx.MockTransport(handler), **options)


@pytest.mark.parametrize("aborted", [False, True])
def test_response_loss_checkpoint_failure_never_counts_as_injection(tmp_path, aborted):
    if aborted:
        (tmp_path / "abort").touch()
    transport = response_loss_transport(
        "admission", lambda _request: httpx.Response(200, json={"id": "job-a", "submissionRevision": 0}),
        job_id="job-a", checkpoint_directory=tmp_path, checkpoint_timeout=0.02,
    )

    async def exercise():
        async with httpx.AsyncClient(transport=transport, base_url="http://fixture") as client:
            with pytest.raises(RuntimeError if aborted else TimeoutError, match="checkpoint"):
                await client.post("/v1/workloads", json={"id": "job-a"})

    asyncio.run(exercise())
    assert transport.capture is not None and not transport.lost and transport.losses == 0 and transport.closed


def test_response_loss_rejects_a_different_submission_revision():
    transport = response_loss_transport(
        "admission", lambda _request: httpx.Response(200, json={"id": "job-a", "submissionRevision": 1}),
        job_id="job-a",
    )

    async def exercise():
        async with httpx.AsyncClient(transport=transport, base_url="http://fixture") as client:
            with pytest.raises(AssertionError):
                await client.post("/v1/workloads", json={"id": "job-a"})

    asyncio.run(exercise())
    assert not transport.lost and transport.closed
