"""Qualify representative generated models without importing the handwritten SDK."""

from __future__ import annotations

import importlib
import inspect
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
from anycloud.configuration import Configuration
from anycloud.models.aws_credential import AwsCredential
from anycloud.models.bucket_entry_page_entries_inner import (
    BucketEntryPageEntriesInner,
)
from anycloud.models.bucket_list_page import BucketListPage
from anycloud.models.delete_secret409_response import DeleteSecret409Response
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_status_response import WorkloadStatusResponse
from anycloud.models.save_secret_body import SaveSecretBody
from anycloud.models.unauthorized_api_error import UnauthorizedApiError
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
    assert not any(
        name == "anycloud_workflows" or name.startswith("anycloud_workflows.")
        for name in sys.modules
    ), "Raw generated imports must not initialize the workflow extension"

    assert Configuration().host == "http://localhost:8080/v1"
    assert Configuration(host="https://api.example.test/v1").host == (
        "https://api.example.test/v1"
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

    admission = {
        "image": "job:latest",
        "cloudConfig": {"region": "us-east-1"},
        "credentialName": "credential",
    }
    assert WorkloadAdmissionInput.from_dict(admission).to_dict() == admission
    expect_invalid(
        lambda: WorkloadAdmissionInput.from_dict(
            {key: value for key, value in admission.items() if key != "image"}
        )
    )
    expect_invalid(
        lambda: BucketEntryPageEntriesInner.from_dict(
            {"key": "unknown", "kind": "nonsense"}
        )
    )

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

    status_fields = {
        "workload": {
            "id": "queued-job",
            "userId": "owner",
            "workloadType": "job",
            "image": "job:latest",
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
    status = WorkloadStatusResponse.from_dict(status_fields)

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
    assert status.retry is None
    assert status.checkpoint is None

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


if __name__ == "__main__":
    main()
