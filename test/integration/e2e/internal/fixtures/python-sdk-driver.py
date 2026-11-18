"""Subprocess bridge for exercising the public Python AsyncClient."""

from __future__ import annotations

import asyncio
import json
import runpy
import signal
import sys
from pathlib import Path
from typing import Any

import httpx
from anycloud import AsyncClient
from anycloud_workflows import JobSubmissionExpired, JobSubmissionUncertain
from anycloud_workflows.jobs import _create_deployment_input


def deployment_json(value: Any) -> dict[str, Any]:
    return value.to_dict()


def deployment_options(request: dict[str, Any]) -> dict[str, Any]:
    return {
        keyword: request[field]
        for field, keyword in (
            ("command", "command"),
            ("env", "env"),
            ("dockerOptions", "docker_options"),
            ("readinessProbe", "readiness_probe"),
            ("maxConcurrentJobsPerReplica", "max_concurrent_jobs_per_replica"),
        )
        if field in request
    }


def submission_options(request: dict[str, Any]) -> dict[str, Any]:
    return {key: request[key] for key in ("timeout", "wait") if key in request}


async def submission_json(job: Any, outcome: str) -> dict[str, Any]:
    workload = (await job.status()).workload
    return {
        "id": job.id,
        "outcome": outcome,
        "claimed": workload.claimed,
        "submissionRevision": workload.submission_revision,
        "claimDeadlineAt": workload.claim_deadline_at,
    }


async def create_node_pool_deployment(request: dict[str, Any], client: AsyncClient) -> Any:
    """Create a node-pool-targeted Deployment through the installed AsyncClient.

    The facade's own request builder proves the wire body carries ``nodePool``
    and no other target before the facade sends the same request.
    """
    node_pool = request["nodePool"]
    options: dict[str, Any] = {
        "command": request.get("command"),
        "env": request.get("env"),
        "secrets": request.get("secrets"),
        "docker_options": request.get("dockerOptions"),
        "max_concurrent_jobs_per_replica": request.get("maxConcurrentJobsPerReplica", 1),
        "min_replicas": request.get("minReplicas"),
        "max_replicas": request.get("maxReplicas"),
        "readiness_probe": request.get("readinessProbe"),
    }
    serialized = _create_deployment_input(
        request["name"], request["image"], node_pool=node_pool, **options
    ).to_dict()
    if "cluster" in serialized or serialized.get("nodePool") != node_pool:
        raise ValueError("Deployment create request did not target the node pool")
    deployment = await client.create_deployment(
        request["name"], request["image"], node_pool=node_pool, **options
    )
    if deployment.node_pool_id != node_pool:
        raise ValueError("Created Deployment does not report the requested node pool")
    return deployment


async def run(request: dict[str, Any], client: AsyncClient) -> dict[str, Any]:
    action = request.get("action")
    if action == "submit_response_loss":
        return await asyncio.wait_for(submit_response_loss(request, client), timeout=60)
    if action == "submit_concurrent":
        identifiers = request["workloadIds"]
        if len(identifiers) < 2 or len(set(identifiers)) != len(identifiers):
            raise ValueError("Concurrent submission requires distinct Job identifiers")
        tasks = [
            asyncio.create_task(
                run(
                    {
                        "action": "submit",
                        "deployment": request["deployment"],
                        "workloadId": identifier,
                        **submission_options(request),
                    },
                    client,
                ),
                name=f"submit-{identifier}",
            )
            for identifier in identifiers
        ]
        try:
            return {"jobs": await asyncio.gather(*tasks)}
        finally:
            # A failed submission must release sibling requests before the
            # shared client closes, including requests still awaiting a claim.
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    if action == "create_deployment":
        return deployment_json(await create_node_pool_deployment(request, client))
    if action == "get_deployment":
        return deployment_json(await client.get_deployment(request["deployment"]))
    if action == "list_deployments":
        return [deployment_json(value) for value in await client.list_deployments()]
    if action == "update_deployment":
        options = deployment_options(request)
        if "image" in request:
            options["image"] = request["image"]
        return deployment_json(await client.update_deployment(request["deployment"], **options))
    if action == "delete_deployment":
        return deployment_json(await client.delete_deployment(request["deployment"]))
    if action == "submit":
        try:
            job = await client.submit(
                deployment=request["deployment"],
                workload_id=request["workloadId"],
                **submission_options(request),
            )
        except JobSubmissionExpired as error:
            return await submission_json(error.job, "expired")
        return await submission_json(
            job, "claimed" if request.get("wait") else "admitted"
        )
    if action == "job_status":
        job = await client.get(request["workloadId"])
        status = await job.status()
        return {
            "id": status.workload.id,
            "deploymentId": status.workload.deployment_id,
            "state": status.workload.state,
            "claimed": status.workload.claimed,
            "submissionRevision": status.workload.submission_revision,
            "claimDeadlineAt": status.workload.claim_deadline_at,
        }
    if action == "terminate_job":
        job = await client.get(request["workloadId"])
        await job.terminate()
        return {"id": job.id}
    if action == "resubmit_job":
        job = await client.get(request["workloadId"])
        try:
            await job.resubmit(**submission_options(request))
        except JobSubmissionExpired:
            return await submission_json(job, "expired")
        return await submission_json(
            job, "claimed" if request.get("wait") else "admitted"
        )
    if action == "reject_targeted_bucket":
        await client.submit(
            deployment=request["deployment"],
            workload_id=request["workloadId"],
            cloud_config={"output_bucket": "must-not-be-mounted"},
        )
        raise AssertionError("targeted bucket input was accepted")
    raise ValueError(f"unknown Python SDK action: {action}")


async def submit_response_loss(request: dict[str, Any], client: AsyncClient) -> dict[str, Any]:
    # Explicitly load only the test helper: -I must keep both SDK packages installed.
    helper = Path(__file__).resolve().parents[3] / "fixtures/python_submission_response_loss.py"
    transport_type = runpy.run_path(str(helper))["LostResponseTransport"]
    transport = transport_type(
        request["fault"],
        job_id=request["workloadId"],
        claimed_only=True,
        checkpoint_directory=Path(request["checkpointDirectory"]),
    )
    previous = client.api_client.rest_client.pool_manager
    if previous is not None:
        await previous.aclose()
    client.api_client.rest_client.pool_manager = httpx.AsyncClient(transport=transport)
    try:
        await client.submit(
            deployment=request["deployment"],
            workload_id=request["workloadId"],
            wait=True,
        )
    except JobSubmissionUncertain as error:
        assert transport.injected_error is not None and error.cause is transport.injected_error
        job = error.job
        assert job.id == request["workloadId"]
        # Do not refresh or reconstruct the handle: its original revision owns recovery.
        assert await job.wait_for_claim() is job
    else:
        raise AssertionError("submission did not surface the injected response loss")
    observations = transport.observations
    assert any(observation["afterLoss"] for observation in observations)
    assert all(
        observation["jobId"] == job.id and observation["submissionRevision"] == 0
        for observation in observations
    )
    assert transport.admissions == 1 and transport.resubmissions == 0 and transport.losses == 1
    status = (await job.status()).workload
    assert status.state == "running" and status.claimed and status.submission_revision == 0
    return {
        "id": job.id,
        "uncertain": True,
        "outcome": "claimed",
        "submissionRevision": status.submission_revision,
        "capture": transport.capture,
        "admissions": transport.admissions,
        "resubmissions": transport.resubmissions,
        "losses": transport.losses,
        "observations": observations,
    }


async def main() -> None:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        raise ValueError("Python SDK driver request must be an object")
    initial_tasks = asyncio.all_tasks()
    client = AsyncClient()
    action_error: BaseException | None = None
    close_error: BaseException | None = None
    transport = None
    result = None
    try:
        await client.__aenter__()
        result = await run(request, client)
    except BaseException as error:
        # Cancellation must reach the action's sibling-cancel/join finalizer.
        # Preserve it (and any simultaneous close error) after observing cleanup.
        action_error = error
    finally:
        transport = client.api_client.rest_client.pool_manager
        try:
            await client.aclose()
        except BaseException as error:
            close_error = error
    pending = asyncio.all_tasks() - initial_tasks
    transport_closed = transport.is_closed if transport is not None else None
    finalization_error = None
    if transport_closed is not True:
        finalization_error = AssertionError("AsyncClient did not close its HTTP transport")
    elif pending:
        finalization_error = AssertionError(f"AsyncClient left pending tasks: {pending}")
    errors = [
        {"phase": phase, "type": type(error).__name__}
        for phase, error in (
            ("action", action_error), ("close", close_error),
            ("observation", finalization_error),
        )
        if error is not None
    ]
    if errors:
        print(json.dumps({
            "kind": "python-sdk-finalization", "action": request.get("action"),
            "client": type(client).__name__, "transportClosed": transport_closed,
            "pendingTasks": len(pending), "errors": errors,
        }, separators=(",", ":")), file=sys.stderr, flush=True)
        if action_error is not None:
            if close_error is not None:
                raise action_error from close_error
            raise action_error
        if close_error is not None:
            raise close_error
        raise finalization_error
    if request.get("action") in ("submit_concurrent", "submit_response_loss"):
        result.update(
            client=type(client).__name__,
            transportClosed=transport_closed,
            pendingTasks=len(pending),
        )
    print(json.dumps(result, separators=(",", ":")), flush=True)


async def process_main() -> None:
    # Execa's ordinary foreground cancellation sends SIGTERM. Give the same
    # action/finalization owner a chance to join requests and close the client;
    # force-kill or interrupted finalization still has no successful receipt.
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    cancelled = False

    def cancel_once() -> None:
        nonlocal cancelled
        if not cancelled:
            cancelled = True
            task.cancel()

    loop.add_signal_handler(signal.SIGTERM, cancel_once)
    try:
        await main()
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


if __name__ == "__main__":
    asyncio.run(process_main())
