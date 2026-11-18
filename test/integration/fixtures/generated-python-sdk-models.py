"""Qualify representative generated models without importing the handwritten SDK."""

from __future__ import annotations

import importlib
import inspect
import json
import os
import pathlib
import pkgutil
import py_compile
import sys
import sysconfig
import tempfile
import typing

from pydantic import ValidationError

import anycloud
from anycloud.api.secrets_api import SecretsApi
from anycloud.api.deployment_workload_api import DeploymentWorkloadApi
from anycloud.configuration import Configuration
from anycloud.models.aws_credential import AwsCredential
from anycloud.models.bucket_entry_page_entries_inner import (
    BucketEntryPageEntriesInner,
)
from anycloud.models.bucket_list_page import BucketListPage
from anycloud.models.create_node_pool_input import CreateNodePoolInput
from anycloud.models.create_deployment_input import CreateDeploymentInput
from anycloud.models.deployment_readiness_probe import DeploymentReadinessProbe
from anycloud.models.delete_secret409_response import DeleteSecret409Response
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_admission_input_any_of import (
    WorkloadAdmissionInputAnyOf,
)
from anycloud.models.workload_admission_input_any_of1 import (
    WorkloadAdmissionInputAnyOf1,
)
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.job_submission_observation import JobSubmissionObservation
from anycloud.models.job_submission_outcome import JobSubmissionOutcome
from anycloud.models.save_secret_body import SaveSecretBody
from anycloud.models.unauthorized_api_error import UnauthorizedApiError
from anycloud.models.update_deployment_body import UpdateDeploymentBody
from anycloud.models.deployment_docker_options_update import DeploymentDockerOptionsUpdate
from anycloud.models.undefined_api_error import UndefinedApiError


def expect_invalid(factory) -> None:
    try:
        factory()
    except (ValidationError, ValueError):
        return
    raise AssertionError("Expected generated model validation to reject the value")


def qualify_all_modules() -> None:
    root = pathlib.Path(anycloud.__path__[0])
    with tempfile.TemporaryDirectory() as compiled:
        for source in root.rglob("*.py"):
            target = pathlib.Path(compiled, source.relative_to(root)).with_suffix(
                ".pyc"
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            py_compile.compile(str(source), cfile=str(target), doraise=True)

    for module in pkgutil.walk_packages(anycloud.__path__, "anycloud."):
        imported = importlib.import_module(module.name)
        for _, value in inspect.getmembers(imported):
            if getattr(value, "__module__", None) != module.name:
                continue
            if inspect.isclass(value):
                typing.get_type_hints(value, include_extras=True)
                for _, method in inspect.getmembers(value):
                    if getattr(method, "__module__", None) == module.name and (
                        inspect.isfunction(method) or inspect.ismethod(method)
                    ):
                        typing.get_type_hints(method, include_extras=True)
            elif inspect.isfunction(value):
                typing.get_type_hints(value, include_extras=True)


def main() -> None:
    package = pathlib.Path(anycloud.__file__).resolve()
    if os.environ.get("ANYCLOUD_EXPECT_INSTALLED") == "1":
        assert sys.prefix != sys.base_prefix, sys.executable
        purelib = pathlib.Path(sysconfig.get_path("purelib")).resolve()
        assert purelib in package.parents, (package, purelib)
        assert pathlib.Path("python/generated/anycloud").resolve() not in package.parents
    else:
        expected = pathlib.Path("python/generated/anycloud").resolve()
        assert expected in package.parents, package
    package_root = pathlib.Path(anycloud.__path__[0])
    forbidden = {
        "client.py",
        "current_deployment.py",
        "errors.py",
        "job.py",
        "job_group.py",
        "storage.py",
        "types.py",
    }
    assert not forbidden.intersection(
        path.name for path in package_root.iterdir()
    )
    qualify_all_modules()
    assert not any("worker" in source.name for source in package_root.rglob("*.py"))
    assert "workload" in WorkloadStatusResponse.model_fields
    assert "deployment" not in WorkloadStatusResponse.model_fields
    assert not any(
        name == "anycloud_workflows" or name.startswith("anycloud_workflows.")
        for name in sys.modules
    ), "Raw generated imports must not initialize the workflow extension"

    assert Configuration().host == "http://localhost:8080/v1"
    assert Configuration(host="https://api.example.test/v1").host == (
        "https://api.example.test/v1"
    )

    assert typing.get_type_hints(JobSubmissionObservation)["outcome"] is (
        JobSubmissionOutcome
    )
    for outcome in JobSubmissionOutcome:
        observation_wire = {
            "claimDeadlineAt": None,
            "claimed": outcome is JobSubmissionOutcome.CLAIMED,
            "outcome": outcome.value,
            "submissionRevision": 0,
        }
        observation = JobSubmissionObservation.from_dict(observation_wire)
        assert observation.outcome is outcome
        assert observation.outcome == outcome.value
        assert json.loads(observation.to_json()) == observation_wire
        expect_invalid(
            lambda: JobSubmissionObservation.from_dict(
                {**observation_wire, "outcome": "unknown"}
            )
        )

    node_pool = {
        "name": "qualification",
        "credentialName": "credential",
        "region": "us-east-1",
        "vmTypes": ["t3.micro"],
        "minVmCount": 0,
        "maxVmCount": 1,
    }
    assert CreateNodePoolInput.from_dict(node_pool).to_dict() == node_pool
    expect_invalid(lambda: CreateNodePoolInput(**{**node_pool, "unknown": True}))
    expect_invalid(
        lambda: CreateNodePoolInput.from_dict({**node_pool, "unknown": True})
    )
    expect_invalid(lambda: CreateNodePoolInput(**{**node_pool, "name": ""}))
    expect_invalid(lambda: CreateNodePoolInput(**{**node_pool, "minVmCount": -1}))
    expect_invalid(
        lambda: CreateNodePoolInput(
            **{key: value for key, value in node_pool.items() if key != "name"}
        )
    )
    expect_invalid(
        lambda: AwsCredential.from_dict(
            {
                "accessKeyId": "access-key",
                "cloudProvider": "GCP",
                "secretAccessKey": "secret-key",
            }
        )
    )

    targeted = WorkloadAdmissionInput.from_dict(
        {"deployment": "deployment-1", "workloadType": "job", "id": "job-1"}
    )
    assert isinstance(targeted.actual_instance, WorkloadAdmissionInputAnyOf)
    dedicated = WorkloadAdmissionInput.from_dict(
        {
            "image": "deployment:latest",
            "cloudConfig": {"region": "us-east-1"},
            "credentialName": "credential",
        }
    )
    assert isinstance(dedicated.actual_instance, WorkloadAdmissionInputAnyOf1)
    expect_invalid(
        lambda: WorkloadAdmissionInput.from_dict(
            {"deployment": "deployment-1", "unexpected": True}
        )
    )
    expect_invalid(
        lambda: WorkloadAdmissionInput.from_dict(
            {
                "deployment": "deployment-1",
                "workloadType": "job",
                "id": "targeted-bucket-rejected",
                "outputBucket": "must-not-be-mounted",
            }
        )
    )
    expect_invalid(
        lambda: WorkloadAdmissionInput.from_dict(
            {"deployment": "deployment-1", "workloadType": "service"}
        )
    )
    expect_invalid(
        lambda: BucketEntryPageEntriesInner.from_dict(
            {"key": "unknown", "kind": "nonsense"}
        )
    )

    deployment = {
        "name": "model-deployments",
        "nodePool": "node-pool-1",
        "image": "deployment:latest",
        "dockerOptions": {"gpus": "all", "runtime": "nvidia"},
        "maxConcurrentJobsPerReplica": 1,
        "minReplicas": 1,
        "maxReplicas": 2,
    }
    assert CreateDeploymentInput.from_dict(deployment).to_dict() == deployment
    probe = {"exec": {"command": ["test", "-f", "/ready"]}, "periodSeconds": 1}
    assert DeploymentReadinessProbe.from_dict(probe).to_dict() == probe
    assert CreateDeploymentInput.from_dict({**deployment, "readinessProbe": probe}).to_dict() == {
        **deployment, "readinessProbe": probe
    }
    for configured in (probe, None):
        assert UpdateDeploymentBody(readiness_probe=configured).to_dict() == {"readinessProbe": configured}
    expect_invalid(lambda: DeploymentReadinessProbe.from_dict({"httpGet": {"port": 8080}}))
    expect_invalid(lambda: DeploymentReadinessProbe.from_dict({"exec": {"command": []}}))
    expect_invalid(lambda: DeploymentReadinessProbe.from_dict({**probe, "periodSeconds": 0}))
    expect_invalid(lambda: CreateDeploymentInput.from_dict({**deployment, "gpuCount": 1}))
    gpu_update = {"dockerOptions": {"gpus": "2", "runtime": "nvidia"}}
    assert UpdateDeploymentBody(**gpu_update).to_dict() == gpu_update
    expect_invalid(lambda: UpdateDeploymentBody.from_dict({"gpuCount": 1}))

    option_updates = (
        {"cpus": "6"},
        {"privileged": False, "binds": []},
        dict.fromkeys(("cpus", "memory", "shmSize", "gpus", "runtime", "binds", "privileged")),
    )
    for fields in option_updates:
        wire = {"dockerOptions": fields}
        assert UpdateDeploymentBody.from_dict(wire).to_dict() == wire
        options = DeploymentDockerOptionsUpdate.from_dict(fields)
        assert UpdateDeploymentBody(docker_options=options).to_dict() == wire
    assert UpdateDeploymentBody(docker_options=None).to_dict() == {"dockerOptions": None}
    assert UpdateDeploymentBody(image="deployment:v2").to_dict() == {"image": "deployment:v2"}
    expect_invalid(lambda: UpdateDeploymentBody.from_dict({"dockerOptionsUpdate": {"cpus": "6"}}))
    expect_invalid(lambda: UpdateDeploymentBody(docker_options_update={"cpus": "6"}))
    expect_invalid(lambda: DeploymentDockerOptionsUpdate(cpus=6))
    expect_invalid(lambda: DeploymentDockerOptionsUpdate(privileged="false"))
    expect_invalid(lambda: DeploymentDockerOptionsUpdate.from_dict({"network": "host"}))
    assert CreateDeploymentInput.from_dict({**deployment, "dockerOptions": {"memory": None}}).to_dict() == {
        **deployment, "dockerOptions": {}
    }

    # Required nullable values must distinguish absent wire keys from null,
    # including nested model conversion; optional fields remain unset.
    page = {
        "buckets": [{"name": "output", "region": None, "createdAt": None}],
        "nextCursor": None,
    }
    assert BucketListPage.from_dict(page).to_dict() == page
    expect_invalid(lambda: BucketListPage.from_dict({"buckets": []}))
    expect_invalid(
        lambda: BucketListPage.from_dict(
            {"buckets": [{"name": "output", "createdAt": None}], "nextCursor": None}
        )
    )
    expect_invalid(lambda: BucketListPage(buckets=[]))

    omitted = UpdateDeploymentBody()
    nullable = UpdateDeploymentBody(command=None)
    assert "command" not in omitted.to_dict()
    assert nullable.to_dict()["command"] is None
    expect_invalid(lambda: UpdateDeploymentBody(maxConcurrentJobsPerReplica=0))

    status_fields = {
        "workload": {
            "claimDeadlineAt": None,
            "claimed": False,
            "submissionRevision": 0,
            "id": "queued-job",
            "userId": "owner",
            "deploymentId": "deployment-1",
            "workloadType": "job",
            "image": "deployment:latest",
            "state": "queued",
            "spot": False,
            "startedAt": 1,
            "dockerCommand": "",
            "vmCount": 0,
            "agent": None,
            "availabilityZone": None,
            "awaitingReleaseMs": None,
            "checkpointBucket": None,
            "checkpointStorageRegion": None,
            "cloudProvider": None,
            "command": None,
            "completedAt": None,
            "costSource": None,
            "diskSizeGb": None,
            "diskTier": None,
            "diskIops": None,
            "diskThroughputMibps": None,
            "regions": None,
            "dnsRecordId": None,
            "dockerOptions": None,
            "gpuType": None,
            "imageDigest": None,
            "inputBucket": None,
            "inputStorageRegion": None,
            "outputBucket": None,
            "outputStorageRegion": None,
            "publicEndpoint": None,
            "region": None,
            "secretNames": None,
            "session": None,
            "sessionLabel": None,
            "endReason": None,
            "lastAttemptEndReason": None,
            "totalCost": None,
            "version": None,
            "vmDurationMs": None,
            "vmType": None,
        },
        "events": [],
        "status": "-",
    }
    missing_position = WorkloadStatusResponse.from_dict(status_fields)
    assert missing_position.jobs_ahead is None
    for position in (0, 3, 2**53 - 1, None):
        status = WorkloadStatusResponse.from_dict(
            {**status_fields, "jobsAhead": position}
        )
        assert status.jobs_ahead == position
        assert status.to_dict()["jobsAhead"] == position
    for invalid_position in (-1, 0.5, 2**53, True, "1"):
        expect_invalid(
            lambda: WorkloadStatusResponse.from_dict(
                {**status_fields, "jobsAhead": invalid_position}
            )
        )

    retry = {"attempt": 3, "earliestAt": 1_000, "latestAt": 2_000}
    checkpoint = {
        "bucket": "spot-job",
        "mount": "/mnt/checkpoint",
        "retained": False,
        "health": {
            "objects": 52,
            "bytes": 105_906_176,
            "lastModifiedAt": None,
            "truncated": False,
        },
    }
    progress = WorkloadStatusResponse.from_dict(
        {**status_fields, "retry": retry, "checkpoint": checkpoint}
    )
    assert progress.to_dict()["retry"] == retry
    assert progress.to_dict()["checkpoint"] == checkpoint
    assert missing_position.retry is None
    assert missing_position.checkpoint is None

    assert SaveSecretBody(values={"TOKEN": "value"}).to_dict() == {
        "values": {"TOKEN": "value"}
    }

    unexpected = DeleteSecret409Response.from_dict(
        {
            "defined": False,
            "code": "UNEXPECTED_CONFLICT",
            "status": 409,
            "message": "Unexpected conflict",
            "data": {"detail": "preserved"},
        }
    )
    assert isinstance(unexpected.actual_instance, UndefinedApiError)
    assert unexpected.actual_instance.data == {"detail": "preserved"}
    expect_invalid(
        lambda: UndefinedApiError(
            defined=True,
            code="UNEXPECTED_CONFLICT",
            status=409,
            message="Unexpected conflict",
        )
    )
    expect_invalid(
        lambda: UnauthorizedApiError(
            defined=False,
            code="UNAUTHORIZED",
            status=401,
            message="Unauthorized",
        )
    )

    management = inspect.signature(SecretsApi.list_secrets)
    assert "any_cloud_client_version" in management.parameters
    assert (
        management.parameters["any_cloud_client_version"].default
        is inspect.Parameter.empty
    )
    for operation in (
        DeploymentWorkloadApi.discover_deployment_job_candidate,
        DeploymentWorkloadApi.claim_deployment_job,
    ):
        assert "any_cloud_client_version" not in inspect.signature(operation).parameters


if __name__ == "__main__":
    main()
