# AnyCloud Python SDK

Submit Jobs and manage your cloud resources with
[AnyCloud](https://anycloud.sh/). Python 3.10 or newer is required. One
`anycloud-sdk` installation provides `anycloud` and `anycloud_workflows`.

## Install and configure

```bash
pip install anycloud-sdk
```

Follow [Getting Started](https://anycloud.sh/getting-started/) to start or select
an API, log in, and save a cloud credential. `Client()` reuses the CLI's API
target and authentication:

```python
from anycloud import Client

with Client() as client:
    print(client.sdk_version)
```

The API URL comes from an explicit `api_url=`, then `API_URL`, then
`$ANYCLOUD_DIR/api-url` (default `~/.anycloud/api-url`), falling back to
`http://localhost:8080`. Authentication comes from an explicit `token=`. A
loopback API URL then uses `$ANYCLOUD_DIR/local-api-token`, which
`anycloud api start` writes. A hosted API takes its own API token:
`ANYCLOUD_API_TOKEN` when `API_URL` names that API, then the token
`anycloud login <api-url>` saved in `$ANYCLOUD_DIR/api-tokens.json`. Explicit
arguments always win: `token=` is the bearer as given,
so against a local API pass its install token. The
context manager closes the client's connections.

API authentication does not select a cloud compute credential. Pass a saved
credential with `credential_name=` on each image-based submission.

## Submit a dedicated Job

Publish an image containing your code and dependencies. Select its command
with a list of arguments; use an immutable tag or digest when reproducibility
matters:

```python
from anycloud import Client

with Client() as client:
    job = client.submit(
        "ghcr.io/acme/trainer:git-a1b2c3d",
        credential_name="aws-prod",
        gpu="h100:8",
        cloud_config={"region": "us-east-1", "spot": True},
        env={"LR": "0.01"},
        command=["python", "-m", "training"],
    )
    print(job.id, job.status().workload.state)
    job.wait(timeout_seconds=3600)
    print(job.last_status.workload.state)
```

`submit()` returns a `Job` handle. Use `status()` to fetch current state,
`wait()` to wait for successful completion, and `terminate()` to request
termination. Keep the owning `Client` open while using its handles.

The async workflow uses the same arguments and completion behavior:

```python
import asyncio

from anycloud import AsyncClient


async def main() -> None:
    async with AsyncClient() as client:
        job = await client.submit(
            "ghcr.io/acme/trainer:git-a1b2c3d",
            credential_name="aws-prod",
            gpu="h100:8",
            cloud_config={"region": "us-east-1", "spot": True},
            env={"LR": "0.01"},
            command=["python", "-m", "training"],
        )
        print(job.id, (await job.status()).workload.state)
        await job.wait(timeout_seconds=3600)
        print(job.last_status.workload.state)


asyncio.run(main())
```

[`job_completion.py`](examples/job_completion.py) contains runnable examples
for both clients. HTTP calls and async polling allow other tasks to progress.

Share one `AsyncClient` across concurrent handlers on the same event loop.
`AsyncJob` provides `await job.wait()`, `status()`, `terminate()`, and explicit
`resubmit()`. Services and other API families use generated operations through
`client.api_client`. Task cancellation propagates normally; supply and save
`workload_id` before submission if you need to recover after a local timeout or
request cancellation. Close the client with its async context manager or
`await client.aclose()`. See the
[async reference](https://anycloud.sh/reference/python-sdk/#async-operations).

### Chain Jobs with shared storage

Wait for one Job before submitting its dependent Job. Attach bucket names
through `cloud_config` to pass data between workloads:

```python
from anycloud import Client

with Client() as client:
    prep = client.submit(
        "ghcr.io/acme/prep:latest",
        credential_name="aws-prod",
        gpu="h100",
        cloud_config={"output_bucket": "prepared-data"},
    )
    prep.wait()

    train = client.submit(
        "ghcr.io/acme/trainer:latest",
        credential_name="aws-prod",
        gpu="h100:8",
        cloud_config={
            "input_bucket": "prepared-data",
            "output_bucket": "trained-models",
        },
    )
    train.wait()
```

The first image writes `/mnt/output`; the next reads `/mnt/input`. Input
buckets must already exist, and output buckets can be created by the API. A
Job's input and output bucket names must differ. Use separate buckets or
application-managed output prefixes for concurrent workflows. See
[Buckets](https://anycloud.sh/platform/buckets/) for checkpoint storage and sync
guarantees.

## Wait, terminate, or reattach

Save `job.id` to observe the same Job from another process:

```python
from anycloud import Client
from anycloud_workflows import WorkloadWaitTimeout, JobFailedError

with Client() as client:
    job = client.get("request-123")
    try:
        job.wait(timeout_seconds=900, poll_interval_seconds=2)
    except JobFailedError as error:
        print(error.workload_id, error.state)
        print(error.status.workload.state)
    except WorkloadWaitTimeout:
        print("Still waiting; requesting termination")
        job.terminate()
```

`wait()` returns the same handle after `completed`. Other terminal states raise
`JobFailedError`, whose `status` contains the terminal response.
`WorkloadWaitTimeout` only stops polling; this example explicitly chooses to
terminate afterward. Termination is a request and does not wait for cleanup.

`get(id)` fetches status and returns a handle with `last_status` populated and
`submission=None`. An eligible terminal Job can be submitted again with
`job.resubmit()`. It keeps the same ID, returns a generated `WorkloadResubmitResponse`,
and clears `last_status` after success. The API requires a resubmittable terminal
state and completed cleanup, so immediate resubmission after `terminate()` can
fail. Resubmission uses the client's configured request timeout as its elapsed
request budget.

## Other resource operations

Use generated API-family clients for credentials, secrets, bucket metadata,
Services, and other operations. They share the workflow client's connections
and SDK version:

```python
from anycloud import Client
from anycloud.api.buckets_api import BucketsApi
from anycloud.api.credentials_api import CredentialsApi
from anycloud.api.secrets_api import SecretsApi
from anycloud.models.save_secret_body import SaveSecretBody

with Client() as client:
    credentials = CredentialsApi(client.api_client).list_credentials_sync(
        client.sdk_version
    )
    print([credential.to_dict()["name"] for credential in credentials])

    SecretsApi(client.api_client).save_secret_sync(
        "training",
        client.sdk_version,
        SaveSecretBody(values={"TOKEN": "replace-with-your-application-token"}),
    )
    job = client.submit(
        "ghcr.io/acme/trainer:latest",
        credential_name="aws-prod",
        gpu="h100",
        secrets=["training"],
    )
    print(job.id)

    page = BucketsApi(client.api_client).list_buckets_sync(
        "aws-prod", client.sdk_version, page_size="100"
    )
    for bucket in page.buckets:
        print(bucket.to_dict()["name"])
```

Saving a secret stores it; `secrets=["training"]` injects its values into the
Job. Bucket listings return a page; use `next_cursor` to request subsequent
pages. Generated response models use Python field names on attributes and
wire names in `from_dict()` and `to_dict()`. Union models expose their selected
model through `actual_instance`; `to_dict()` also works across these variants.

### Generated clients and asynchronous calls

Generated API operations have asynchronous methods and synchronous `_sync`
variants. If you construct `ApiClient` directly, supply the API host ending in
`/v1`, authentication, and the exact installed SDK version:

```python
import asyncio
import os
from importlib.metadata import version

from anycloud.api.secrets_api import SecretsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration


async def main() -> None:
    configuration = Configuration(
        host="http://localhost:8080/v1",
        access_token=os.environ["GITHUB_TOKEN"],
    )
    async with ApiClient(configuration) as client:
        secrets = await SecretsApi(client).list_secrets(version("anycloud-sdk"))
        print([secret.name for secret in secrets])


asyncio.run(main())
```

`Configuration` does not perform the workflow client's CLI discovery. The
lower-level `anycloud_workflows.wait_for_terminal_workload()` accepts an
existing generated client and returns a generated status response at any
terminal state. See the
[SDK reference](https://anycloud.sh/reference/python-sdk/) for generated
workload operations, method arguments, and return models.

## Errors and current limitations

Generated API exceptions retain their types.
Catch `anycloud.exceptions.ApiException` or a status-specific subclass, such as
`ConflictException`. HTTP status is in `error.status`; declared error data is
in `error.data`. See
[error handling](https://anycloud.sh/reference/python-sdk/#error-handling) for
typed error examples.

`from anycloud import Client` and `from anycloud_workflows import Client` refer
to the same class; the corresponding `AsyncClient` imports also share one class.
Import `AsyncJob` and polling errors
from `anycloud_workflows`. Select compute credentials per submission with
`credential_name=`, and use `timeout_seconds=` for waiting.

Service handles, `JobGroup`, `submit_many()`, and `get_or_submit()` are not
available. Compose independent Jobs with ordinary Python loops and use
generated operations for Services. SDK log streaming, exec, bucket handles,
and bucket uploads and downloads are also absent; use the CLI for those
transports. Bucket metadata operations and workload storage attachments remain
available as shown above.

For contributor guidance, read [`extensions/README.md`](extensions/README.md).
Generated source lives under `generated/anycloud` and must not be edited by
hand. Run `yarn generate:python-sdk` from the repository root after a contract
or package-version change.
