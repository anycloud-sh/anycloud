"""Exercise the generated SDK against a real API listener."""

from __future__ import annotations

import asyncio
import json
import os

from uuid import uuid4
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from anycloud.api.deployment_workload_api import DeploymentWorkloadApi
from anycloud.models.workload_claim_job_body import WorkloadClaimJobBody
from anycloud.models.workload_outcome_body import WorkloadOutcomeBody
from anycloud.api.secrets_api import SecretsApi
from anycloud.api.buckets_api import BucketsApi
from anycloud.api.credentials_api import CredentialsApi
from anycloud.api.workload_admission_api import WorkloadAdmissionApi
from anycloud.api.workloads_api import WorkloadsApi
from anycloud.api.deployments_api import DeploymentsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration
from anycloud.exceptions import (
    BadRequestException,
    ConflictException,
    NotFoundException,
    UnauthorizedException,
)
from anycloud.models.boolean_query_value import BooleanQueryValue
from anycloud.models.save_credential_body import SaveCredentialBody
from anycloud.models.client_version_mismatch_api_error import (
    ClientVersionMismatchApiError,
)
from anycloud.models.create_deployment_input import CreateDeploymentInput
from anycloud.models.credential_not_found_api_error import CredentialNotFoundApiError
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_resubmit_body import WorkloadResubmitBody
from anycloud.models.save_secret_body import SaveSecretBody
from anycloud.models.secret_in_use_api_error import SecretInUseApiError
from anycloud.models.unauthorized_api_error import UnauthorizedApiError
from anycloud.models.update_deployment_body import UpdateDeploymentBody
from anycloud.sync_helper import run_sync


def defined_error(exception, expected_type):
    response = exception.data
    assert response is not None
    error = response.actual_instance
    assert isinstance(error, expected_type), type(error)
    return error


def workload_probe(client: ApiClient, api_url: str, token: str) -> dict[str, object]:
    api = DeploymentWorkloadApi(client)
    first = api.discover_deployment_job_candidate_sync("wire-deployment", wait_ms=0)
    assert first.job_id == "wire-first"
    previous_execution = "abcdefab-1234-4234-8234-abcdefabcdef"
    assert str(first.previous_execution_id) == previous_execution
    body = WorkloadClaimJobBody(
        submission_revision=first.submission_revision,
        previous_execution_id=first.previous_execution_id,
    )
    assert json.loads(body.to_json()) == {"submissionRevision": 0, "previousExecutionId": previous_execution}
    execution = uuid4()
    selected = api.claim_deployment_job_sync("wire-deployment", first.job_id, execution, body)
    replay = api.claim_deployment_job_sync("wire-deployment", first.job_id, execution, body)
    assert selected == replay
    assert str(selected.execution_id) == str(execution)
    assert api.discover_deployment_job_candidate_sync("wire-deployment", wait_ms=0) is None

    try:
        api.claim_deployment_job_sync(
            "wire-deployment", first.job_id, execution,
            WorkloadClaimJobBody(submission_revision=1, previous_execution_id=None),
        )
    except ConflictException as error:
        assert error.data.actual_instance.code == "WORKLOAD_CONFLICT"
    else:
        raise AssertionError("A changed replay tuple must conflict")

    api.report_deployment_job_outcome_sync(
        "wire-deployment", first.job_id,
        WorkloadOutcomeBody(execution_id=execution, outcome="completed"),
    )
    for key, expected in [(execution, "WORKLOAD_EXECUTION_USED"), (uuid4(), "WORKLOAD_CANDIDATE_STALE")]:
        try:
            api.claim_deployment_job_sync("wire-deployment", first.job_id, key, body)
        except ConflictException as error:
            assert error.data.actual_instance.code == expected
        else:
            raise AssertionError(f"Expected permanent result {expected}")

    second = api.discover_deployment_job_candidate_sync("wire-deployment", wait_ms=0)
    assert second.job_id == "wire-second"
    assert second.previous_execution_id is None
    second_execution = uuid4()
    api.claim_deployment_job_sync(
        "wire-deployment", second.job_id, second_execution,
        WorkloadClaimJobBody(submission_revision=second.submission_revision, previous_execution_id=second.previous_execution_id),
    )
    api.report_deployment_job_outcome_sync(
        "wire-deployment", second.job_id,
        WorkloadOutcomeBody(execution_id=second_execution, outcome="completed"),
    )
    request = Request(
        f"{api_url}/v1/deployments/wire-deployment/jobs/wire-third/claim",
        data=json.dumps({"submissionRevision": 0}).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Idempotency-Key": str(uuid4())},
    )
    try:
        with urlopen(request) as response:
            raise AssertionError(f"Unexpected invalid-body response {response.status}")
    except HTTPError as error:
        assert error.code == 400
    return {"claimed": [first.job_id, second.job_id], "replayed": True, "explicitNull": True}


def sync_probe(api_url: str, version: str, token: str) -> dict[str, object]:
    client = ApiClient(Configuration(host=f"{api_url}/v1", access_token=token))
    secrets = SecretsApi(client)
    credentials = CredentialsApi(client)
    buckets = BucketsApi(client)
    deployments = DeploymentsApi(client)
    admission = WorkloadAdmissionApi(client)
    workloads = WorkloadsApi(client)
    try:
        workload = workload_probe(client, api_url, token)
        assert credentials.list_credentials_sync(version) == []
        assert secrets.list_secrets_sync(version) == []
        assert (
            secrets.save_secret_sync(
                "locked",
                version,
                SaveSecretBody(values={"TOKEN": "value"}),
            )
            is None
        )

        try:
            secrets.delete_secret_sync("locked", version)
        except ConflictException as exception:
            conflict = defined_error(exception, SecretInUseApiError)
            assert conflict.data.name == "locked"
            assert conflict.data.workload_ids == ["workload-1"]
        else:
            raise AssertionError("Expected a typed secret conflict")

        try:
            secrets.list_secrets_sync("incorrect-version")
        except BadRequestException as exception:
            mismatch = defined_error(exception, ClientVersionMismatchApiError)
            assert mismatch.status == 400
        else:
            raise AssertionError("Expected a typed client-version mismatch")

        assert (
            secrets.delete_secret_sync(
                "locked", version, force=BooleanQueryValue.TRUE
            )
            is None
        )
        assert secrets.list_secrets_sync(version) == []

        assert (
            credentials.save_credential_sync(
                "prod aws",
                version,
                SaveCredentialBody.from_dict(
                    {
                        "cloudProvider": "AWS",
                        "accessKeyId": "AKIAEXAMPLE",
                        "secretAccessKey": "secret-value",
                    }
                ),
                overwrite=BooleanQueryValue.TRUE,
            )
            is None
        )
        expected_credential = {
            "name": "prod aws",
            "cloudProvider": "AWS",
            "accessKeyId": "AKIAEXAMPLE",
        }
        assert [item.to_dict() for item in credentials.list_credentials_sync(version)] == [
            expected_credential
        ]
        assert credentials.get_credential_sync(
            "prod aws", version
        ).to_dict() == expected_credential

        bucket_page = buckets.list_buckets_sync(
            "prod aws", version, page_size="5"
        )
        assert [item.to_dict()["name"] for item in bucket_page.buckets] == [
            "training data"
        ]
        object_page = buckets.list_bucket_objects_sync(
            "prod aws",
            "training data",
            version,
            recursive="true",
            page_size="5",
        )
        assert [item.to_dict()["key"] for item in object_page.entries] == [
            "models/final.bin"
        ]
        assert (
            buckets.delete_bucket_object_sync(
                "prod aws", "training data", "models/final.bin", version
            )
            is None
        )

        deployment = deployments.create_deployment_sync(
            version,
            CreateDeploymentInput.from_dict(
                {
                    "name": "model-deployments",
                    "nodePool": "node-pool-1",
                    "image": "python-deployment:latest",
                    "command": ["python", "deployment.py"],
                    "env": {"MODEL": "example"},
                    "secrets": ["model-db"],
                    "dockerOptions": {"gpus": "all", "runtime": "nvidia"},
                    "maxConcurrentJobsPerReplica": 2,
                }
            ),
        ).deployment
        deployment_list = deployments.list_deployments_sync(version).deployments
        filtered_deployments = deployments.list_deployments_sync(
            version, node_pool="training pool", _request_timeout=10.0
        ).deployments
        assert deployments.get_deployment_sync(deployment.id, version).deployment.id == deployment.id
        live = deployments.get_deployment_sync(deployment.id, version).deployment.status
        assert live.observation == "unavailable"
        assert live.application_ready is None
        assert deployment_list[0].status is None
        updated = deployments.update_deployment_sync(
            deployment.id,
            version,
            UpdateDeploymentBody(
                command=None, secrets=None, docker_options={"gpus": "1"}
            ),
        ).deployment
        assert deployment.secret_names == ["model-db"]
        assert updated.secret_names == []

        for options_update in (
            {"cpus": "6"},
            {"memory": None, "privileged": False, "binds": []},
        ):
            deployments.update_deployment_sync(
                deployment.id,
                version,
                UpdateDeploymentBody(docker_options=options_update),
            )

        targeted = admission.submit_workload_sync(
            version,
            WorkloadAdmissionInput.from_dict(
                {
                    "deployment": deployment.id,
                    "workloadType": "job",
                    "id": "python-targeted-job",
                }
            ),
        )
        queued_status = workloads.get_workload_status_sync(
            targeted.id, version
        )
        assert queued_status.workload.state == "queued"
        assert queued_status.jobs_ahead == 2
        targeted_status = workloads.get_workload_status_sync(targeted.id, version)
        assert targeted_status.workload.state == "errored"
        assert targeted_status.jobs_ahead is None
        assert targeted_status.workload.deployment_id == deployment.id
        assert targeted_status.workload.image is None
        assert targeted_status.workload.image_digest is None
        assert targeted_status.workload.command is None
        assert targeted_status.workload.docker_options is None
        assert targeted_status.workload.cloud_provider is None
        assert targeted_status.workload.region is None
        assert targeted_status.workload.vm_type is None
        assert not {
            "env", "githubToken", "sshPrivateKey", "credentialId"
        } & targeted_status.workload.to_dict().keys()
        draining = deployments.delete_deployment_sync(deployment.id, version).deployment

        job = admission.submit_workload_sync(
            version,
            WorkloadAdmissionInput.from_dict(
                {
                    "image": "python-wire:latest",
                    "cloudConfig": {"region": "us-east-1"},
                    "credentialName": "prod aws",
                    "id": "python-job",
                }
            ),
        )
        listed = workloads.list_workloads_sync(version, limit="5")
        assert listed[0].image == "python-wire:latest"
        for row in listed[:2]:
            assert not {
                "env", "githubToken", "sshPrivateKey"
            } & row.to_dict().keys()
        assert listed[1].deployment_id == deployment.id
        assert listed[1].image is None
        assert listed[1].image_digest is None
        assert listed[1].command is None
        assert listed[1].docker_options is None
        assert listed[1].cloud_provider is None
        assert listed[1].credential_id is None
        status = workloads.get_workload_status_sync(job.id, version)
        assert status.jobs_ahead is None
        assert workloads.terminate_workload_sync(job.id, version).message
        assert workloads.resubmit_workload_sync(
            job.id, version, WorkloadResubmitBody()
        ).message

        assert credentials.delete_credential_sync("prod aws", version) is None
        assert credentials.delete_credential_sync("prod aws", version) is None
        try:
            credentials.get_credential_sync("prod aws", version)
        except NotFoundException as exception:
            missing = defined_error(exception, CredentialNotFoundApiError)
            assert missing.data.name == "prod aws"
        else:
            raise AssertionError("Expected a typed missing-credential error")
    finally:
        run_sync(client.close())

    anonymous_client = ApiClient(Configuration(host=f"{api_url}/v1"))
    try:
        try:
            SecretsApi(anonymous_client).list_secrets_sync(version)
        except UnauthorizedException as exception:
            unauthorized = defined_error(exception, UnauthorizedApiError)
            assert unauthorized.status == 401
        else:
            raise AssertionError("Expected generated Bearer authentication")
    finally:
        run_sync(anonymous_client.close())

    return {
        "deploymentExecution": workload,
        "credential": expected_credential,
        "bucket": {
            "name": bucket_page.buckets[0].to_dict()["name"],
            "object": object_page.entries[0].to_dict()["key"],
        },
        "workload": {
            "id": job.id,
            "listed": [item.id for item in listed],
            "state": status.events[-1].state,
        },
        "deployment": {
            "id": deployment.id,
            "listed": [item.id for item in deployment_list],
            "filtered": [item.id for item in filtered_deployments],
            "generation": updated.generation,
            "targetedJobId": targeted.id,
            "targetedJobsAhead": queued_status.jobs_ahead,
            "targetedState": targeted_status.workload.state,
            "draining": draining.deletion_requested_at is not None,
        },
        "conflict": type(conflict).__name__,
        "workloads": conflict.data.workload_ids,
        "notFound": type(missing).__name__,
        "mismatch": type(mismatch).__name__,
        "unauthorized": type(unauthorized).__name__,
    }


async def async_probe(api_url: str, version: str, token: str) -> dict[str, object]:
    configuration = Configuration(host=f"{api_url}/v1", access_token=token)
    async with ApiClient(configuration) as client:
        deployment_list = await DeploymentsApi(client).list_deployments(
            version, node_pool="node-pool-1", _request_timeout=10.0
        )
        api = DeploymentWorkloadApi(client)
        candidate = await api.discover_deployment_job_candidate("wire-deployment", wait_ms=0)
        assert candidate.job_id == "wire-third"
        execution = uuid4()
        selected = await api.claim_deployment_job(
            "wire-deployment", candidate.job_id, execution,
            WorkloadClaimJobBody(submission_revision=candidate.submission_revision, previous_execution_id=candidate.previous_execution_id),
        )
        assert str(selected.execution_id) == str(execution)
        await api.report_deployment_job_outcome(
            "wire-deployment", candidate.job_id,
            WorkloadOutcomeBody(execution_id=execution, outcome="completed"),
        )
        empty = await api.discover_deployment_job_candidate("wire-deployment", wait_ms=0)
        return {
            "secrets": await SecretsApi(client).list_secrets(version),
            "deployments": [deployment.id for deployment in deployment_list.deployments],
            "claimed": selected.job_id,
            "empty": empty is None,
        }


def main() -> None:
    api_url = os.environ["API_URL"]
    version = os.environ["API_VERSION"]
    token = os.environ["GITHUB_TOKEN"]
    result = sync_probe(api_url, version, token)
    result["async"] = asyncio.run(async_probe(api_url, version, token))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
