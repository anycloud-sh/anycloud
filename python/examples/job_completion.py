"""Submit an image Job and wait for completion with either client.

Run with CLI-compatible API/token configuration and a saved compute credential:
    python python/examples/job_completion.py ghcr.io/acme/trainer:latest aws-prod
    python python/examples/job_completion.py ghcr.io/acme/trainer:latest aws-prod --async
"""

import argparse
import asyncio

from anycloud import AsyncClient, Client
from anycloud_workflows import AsyncJob, Job


def run_job(
    client: Client, image: str, credential_name: str, *, job_id: str | None = None
) -> Job:
    job = client.submit(image, credential_name=credential_name, workload_id=job_id)
    job.wait(timeout_seconds=3600)
    return job


async def run_job_async(
    client: AsyncClient, image: str, credential_name: str, *, job_id: str | None = None
) -> AsyncJob:
    job = await client.submit(image, credential_name=credential_name, workload_id=job_id)
    await job.wait(timeout_seconds=3600)
    return job


async def async_main(args: argparse.Namespace) -> None:
    async with AsyncClient() as client:
        job = await run_job_async(client, args.image, args.credential, job_id=args.job_id)
        print(job.id, job.last_status.workload.state)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Published container image")
    parser.add_argument("credential", help="Saved compute credential name")
    parser.add_argument("--job-id", help="Optional application-assigned Job ID")
    parser.add_argument("--async", dest="use_async", action="store_true")
    args = parser.parse_args()
    if args.use_async:
        asyncio.run(async_main(args))
    else:
        with Client() as client:
            job = run_job(client, args.image, args.credential, job_id=args.job_id)
            print(job.id, job.last_status.workload.state)


if __name__ == "__main__":
    main()
