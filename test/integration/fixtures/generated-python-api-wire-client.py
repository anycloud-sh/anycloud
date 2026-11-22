"""Exercise the generated SDK against a real API listener."""

from __future__ import annotations

import asyncio
import json
import os

from anycloud.api.secrets_api import SecretsApi
from anycloud.api.buckets_api import BucketsApi
from anycloud.api.credentials_api import CredentialsApi
from anycloud.api.workload_admission_api import WorkloadAdmissionApi
from anycloud.api.workloads_api import WorkloadsApi
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
from anycloud.models.credential_not_found_api_error import CredentialNotFoundApiError
from anycloud.models.workload_admission_input import WorkloadAdmissionInput
from anycloud.models.workload_resubmit_body import WorkloadResubmitBody
from anycloud.models.save_secret_body import SaveSecretBody
from anycloud.models.secret_in_use_api_error import SecretInUseApiError
from anycloud.models.unauthorized_api_error import UnauthorizedApiError
from anycloud.sync_helper import run_sync


def defined_error(exception, expected_type):
    response = exception.data
    assert response is not None
    error = response.actual_instance
    assert isinstance(error, expected_type), type(error)
    return error


def sync_probe(api_url: str, version: str, token: str) -> dict[str, object]:
    client = ApiClient(Configuration(host=f"{api_url}/v1", access_token=token))
    secrets = SecretsApi(client)
    credentials = CredentialsApi(client)
    buckets = BucketsApi(client)
    admission = WorkloadAdmissionApi(client)
    workloads = WorkloadsApi(client)
    try:
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
        for row in listed:
            assert not {
                "env", "githubToken", "sshPrivateKey"
            } & row.to_dict().keys()
        status = workloads.get_workload_status_sync(job.id, version)
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
        "conflict": type(conflict).__name__,
        "workloads": conflict.data.workload_ids,
        "notFound": type(missing).__name__,
        "mismatch": type(mismatch).__name__,
        "unauthorized": type(unauthorized).__name__,
    }


async def async_probe(api_url: str, version: str, token: str) -> dict[str, object]:
    configuration = Configuration(host=f"{api_url}/v1", access_token=token)
    async with ApiClient(configuration) as client:
        return {"secrets": await SecretsApi(client).list_secrets(version)}


def main() -> None:
    api_url = os.environ["API_URL"]
    version = os.environ["API_VERSION"]
    token = os.environ["GITHUB_TOKEN"]
    result = sync_probe(api_url, version, token)
    result["async"] = asyncio.run(async_probe(api_url, version, token))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
