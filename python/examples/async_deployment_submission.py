"""Submit a request to an existing Deployment from an async application.

Run with CLI-compatible API/token configuration:
    python python/examples/async_deployment_submission.py model-deployments
"""

import argparse
import asyncio
import json

from anycloud import AsyncClient
from anycloud_workflows import JobSubmissionExpired, JobSubmissionUncertain


async def submit_request(
    client: AsyncClient,
    deployment: str,
    *,
    job_id: str | None = None,
    timeout: float = 5,
) -> dict[str, str]:
    """Return a pickup result suitable for an async HTTP request handler."""
    try:
        job = await client.submit(
            deployment=deployment, workload_id=job_id, timeout=timeout, wait=True
        )
    except JobSubmissionExpired as error:
        # This submission cannot start later; another provider may now be tried.
        return {"outcome": "expired", "job_id": error.job.id}
    except JobSubmissionUncertain as error:
        # Retain this ID for reconciliation. Unknown does not authorize fallback.
        return {"outcome": "unknown", "job_id": error.job.id}
    return {"outcome": "claimed", "job_id": job.id}


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deployment", help="Existing Deployment name or ID")
    parser.add_argument("--job-id", help="Optional application-assigned Job ID")
    parser.add_argument("--timeout", type=float, default=5)
    args = parser.parse_args()
    async with AsyncClient() as client:
        print(
            json.dumps(
                await submit_request(
                    client, args.deployment, job_id=args.job_id, timeout=args.timeout
                )
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
