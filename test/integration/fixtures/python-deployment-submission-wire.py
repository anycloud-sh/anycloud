"""Exercise default public Deployment submission against the production API."""

import asyncio
import json
import os
import re
import runpy
import sys
from pathlib import Path

import anycloud
import anycloud_workflows
import httpx
from anycloud import AsyncClient, Client
from anycloud.exceptions import ApiException
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud_workflows import JobSubmissionExpired, JobSubmissionChanged

from python_submission_response_loss import LostResponseTransport


def sync_probe():
    with Client(token="mock-github-token") as client:
        job = client.submit(deployment="wire-deployment", timeout=0)
        assert re.fullmatch(r"job-[a-f0-9]{24}", job.id), job.id
        try:
            job.wait_for_claim()
        except JobSubmissionExpired:
            pass
        else:
            raise AssertionError("unclaimed submission did not expire")
        before = job.status()
        assert before.workload.claimed is False
        assert before.workload.submission_revision == 0
        old = client.get(job.id)
        assert old.last_status.workload.submission_revision == 0
        receipt = job.resubmit(timeout=0)
        assert isinstance(receipt, WorkloadResubmitResponse)
        assert receipt.submission_revision == 1
        assert job.id == before.workload.id
        try:
            old.wait_for_claim()
        except JobSubmissionChanged:
            pass
        else:
            raise AssertionError("old observer followed a new submission")
        try:
            job.wait_for_claim()
        except JobSubmissionExpired:
            pass
        else:
            raise AssertionError("resubmission did not replace deadline")
        # Blocking success acknowledges a durable claim even though the handler
        # remains held by the test until after this subprocess returns.
        running = client.submit(deployment="wire-deployment", timeout=5, wait=True)
        status = running.status()
        assert status.workload.state == "running"
        assert status.workload.claimed is True
        actual_version = client._sdk_version
        client._sdk_version = "0.0.0-mismatch"
        try:
            running.status()
        except ApiException as error:
            assert error.status == 400
            assert "CLIENT_VERSION_MISMATCH" in str(error)
        else:
            raise AssertionError("mismatched SDK version was accepted")
        finally:
            client._sdk_version = actual_version
        return {"expired": job.id, "running": running.id}


async def async_probe():
    # Exercise the runnable customer example, not a separately reconstructed loop.
    example = (
        Path(__file__).resolve().parents[3]
        / "python/examples/async_deployment_submission.py"
    )
    submit_request = runpy.run_path(str(example))["submit_request"]
    async with AsyncClient(token="mock-github-token") as client:
        first, second = await asyncio.gather(
            submit_request(client, "wire-deployment"),
            submit_request(client, "wire-deployment"),
        )
        assert first["outcome"] == second["outcome"] == "claimed"
        assert first["job_id"] != second["job_id"]
        running = await client.get(first["job_id"])
        peer = await client.get(second["job_id"])
        assert running.last_status.workload.state == "running"
        assert peer.last_status.workload.state == "running"
        assert running.last_status.workload.claimed is True

        # Both slots remain occupied while the server's pickup deadline elapses.
        expired = await submit_request(client, "wire-deployment", timeout=0.25)
        assert expired["outcome"] == "expired"
        job = await client.get(expired["job_id"])
        old = await client.get(job.id)
        assert old.last_status.workload.submission_revision == 0
        receipt = await job.resubmit(timeout=0)
        assert isinstance(receipt, WorkloadResubmitResponse)
        assert receipt.submission_revision == 1
        try:
            await old.wait_for_claim()
        except JobSubmissionChanged:
            pass
        else:
            raise AssertionError("async observer followed a newer submission")
        try:
            await job.wait_for_claim()
        except JobSubmissionExpired as error:
            assert error.job is job and error.revision == 1
        else:
            raise AssertionError("async resubmission did not expire")
        assert (await job.status()).workload.claimed is False

        actual_version = client._sdk_version
        client._sdk_version = "0.0.0-mismatch"
        try:
            await running.status()
        except ApiException as error:
            assert error.status == 400 and "CLIENT_VERSION_MISMATCH" in str(error)
        else:
            raise AssertionError("async client bypassed version enforcement")
        finally:
            client._sdk_version = actual_version

    uncertain_ids = []
    for fault in ("admission", "observation"):
        transport = LostResponseTransport(fault)
        async with AsyncClient(token="mock-github-token") as client:
            client.api_client.rest_client.pool_manager = httpx.AsyncClient(
                transport=transport
            )
            result = await submit_request(client, "wire-deployment", timeout=0)
            assert result["outcome"] == "unknown"
            assert transport.lost and transport.admissions == 1
            recovered = await client.get(result["job_id"])
            assert recovered.last_status.workload.claimed is False
            try:
                await recovered.wait_for_claim()
            except JobSubmissionExpired:
                pass
            else:
                raise AssertionError("uncertain submission did not reconcile to expiry")
            assert transport.admissions == 1, "Recovery resubmitted the job"
            assert transport.resubmissions == 0
            await recovered.terminate()
            uncertain_ids.append(recovered.id)
    return {
        "expired": job.id,
        "running": running.id,
        "peer": peer.id,
        "uncertain": uncertain_ids,
    }


def main():
    if os.environ.get("ANYCLOUD_WHEEL_TEST"):
        source = Path(__file__).resolve().parents[3] / "python"
        for module in (anycloud, anycloud_workflows):
            assert not Path(module.__file__).resolve().is_relative_to(source)
    result = asyncio.run(async_probe()) if sys.argv[1:] == ["async"] else sync_probe()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
