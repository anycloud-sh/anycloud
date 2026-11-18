"""Run complete sync/async convenience workflows against a real API listener."""

import asyncio
import inspect
import json
import os
import runpy
from pathlib import Path
from unittest.mock import patch

import anycloud
import anycloud_workflows
from anycloud import AsyncClient, Client
from anycloud.models.workload_resubmit_response import WorkloadResubmitResponse
from anycloud.models.docker_options import DockerOptions
from anycloud.models.deployment_summary import DeploymentSummary
from anycloud_workflows import JobFailedError


async def call(operation, *args, **kwargs):
    result = operation(*args, **kwargs)
    return await result if inspect.isawaitable(result) else result


async def workflow(client):
    example = Path(__file__).resolve().parents[3] / "python/examples/job_completion.py"
    run_job = runpy.run_path(str(example))[
        "run_job_async" if isinstance(client, AsyncClient) else "run_job"
    ]
    job = await call(run_job, client, "trainer:v1", "prod aws", job_id="parity-image")
    assert job.id == "parity-image"
    assert job.last_status.workload.state == "completed"
    attached = await call(client.get, job.id)
    assert attached.submission is None
    assert attached.last_status.workload.state == "completed"
    await call(attached.terminate)
    resubmitted = await call(attached.resubmit)
    assert isinstance(resubmitted, WorkloadResubmitResponse)
    assert resubmitted.submission_revision is None
    assert attached.last_status is None

    deployment = await call(
        client.create_deployment, "parity deployments", "deployment:v1", node_pool="node-pool-1",
        command=("python", "deployment.py"), env={"MODEL": "v1"},
        docker_options=DockerOptions(shm_size="8g"), max_concurrent_jobs_per_replica=2,
    )
    assert isinstance(deployment, DeploymentSummary)
    assert deployment.command == ["python", "deployment.py"]
    assert deployment.env_keys == ["MODEL"]
    listed = await call(client.list_deployments)
    filtered = await call(client.list_deployments, node_pool="training pool")
    assert [item.id for item in listed] == [item.id for item in filtered] == [deployment.id]
    assert (await call(client.get_deployment, " parity deployments ")).id == deployment.id
    updated = await call(
        client.update_deployment, deployment.id, command=None, env=None,
        docker_options={"memory": None, "cpus": "2", "binds": []},
    )
    assert updated.command is None
    assert updated.env_keys == []
    assert updated.image == deployment.image
    assert updated.generation == deployment.generation + 1

    targeted = await call(client.submit, deployment=deployment.id, workload_id="python-targeted-job")
    assert (await call(targeted.status)).jobs_ahead == 2
    try:
        await call(targeted.wait, timeout_seconds=10)
    except JobFailedError as error:
        assert error.state == "errored"
        assert error.status is targeted.last_status
    else:
        raise AssertionError("Unsuccessful completion must raise JobFailedError")
    draining = await call(client.delete_deployment, deployment.id)
    assert draining.deletion_requested_at is not None
    assert draining.deleted_at is None
    return {"image": job.id, "deployment": deployment.id, "targeted": targeted.id}


async def main():
    if os.environ.get("ANYCLOUD_WHEEL_TEST"):
        source = Path(__file__).resolve().parents[3] / "python"
        for module in (anycloud, anycloud_workflows):
            assert not Path(module.__file__).resolve().is_relative_to(source)
    # A remote API gets its own token, never the GitHub sign-in or the local
    # API's token.
    remote_environment = {
        "API_URL": "https://api.example.com",
        "ANYCLOUD_API_TOKEN": "remote-api-token",
    }
    with patch.dict(os.environ, remote_environment), Client() as remote:
        assert remote.api_client.configuration.access_token == "remote-api-token"
        assert "AnyCloud-GitHub-Token" not in remote.api_client.default_headers
    config = {"api_url": os.environ["API_URL"]}
    if os.environ["ANYCLOUD_CLIENT_MODE"] == "async":
        async with AsyncClient(**config) as client:
            result = await workflow(client)
            pool = client.api_client.rest_client.pool_manager
    else:
        with Client(**config) as client:
            result = await workflow(client)
            pool = client.api_client.rest_client.pool_manager
    assert pool.is_closed
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
