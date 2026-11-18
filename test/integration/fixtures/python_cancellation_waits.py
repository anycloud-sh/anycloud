"""Exercise generated cancellation clients through real HTTPX connection pools."""

from __future__ import annotations

import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

import httpx
from anycloud.models.selected_job import SelectedJob
from anycloud.sync_helper import run_sync
from anycloud_workflows import CurrentJob, DeploymentContext
from anycloud_workflows._request_deadline import RequestDeadlineExceeded


def qualify_cancellation_waits() -> None:
    started = {name: Event() for name in ("wait-a", "wait-b")}
    release = Event()
    requests: list[tuple[str, str, str | None, dict[str, list[str]]]] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args: object) -> None:
            pass

        def reply(self, status: int, body: bytes = b"") -> None:
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            if body:
                self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            job_id = url.path.split("/")[-2]
            requests.append(("cancellation", job_id, self.headers.get("Authorization"), query))
            wait_ms = int(query.get("waitMs", ["0"])[0])
            if job_id in started:
                started[job_id].set()
            cancelled = release.wait(wait_ms / 1000) if wait_ms else release.is_set()
            self.reply(200, json.dumps({"cancelled": cancelled}).encode())

        def do_POST(self) -> None:
            path = urlsplit(self.path).path.split("/")
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body["executionId"] == "00000000-0000-4000-8000-000000000021"
            requests.append((path[-1], path[-2], self.headers.get("Authorization"), {}))
            self.reply(204)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("initial-token\n")
            with DeploymentContext(
                api_url=f"http://127.0.0.1:{server.server_port}",
                deployment_id="deployment",
                token_file=token_file,
            ) as deployment, ThreadPoolExecutor(max_workers=4) as executor:
                # MockTransport bypasses pooling. Use the generated clients'
                # actual HTTP transport with only two connections per pool.
                for client in (deployment._client, deployment._wait_client):
                    client.rest_client.pool_manager = httpx.AsyncClient(
                        limits=httpx.Limits(max_connections=2, max_keepalive_connections=2)
                    )

                def job(name: str) -> CurrentJob:
                    return CurrentJob(deployment, SelectedJob(
                        jobId=name,
                        executionId=UUID("00000000-0000-4000-8000-000000000021"),
                    ))

                waits = [executor.submit(job(name).cancellation_requested, timeout=20) for name in started]
                try:
                    for event in started.values():
                        assert event.wait(3), "Cancellation wait did not reach the server"
                    assert all(not wait.done() for wait in waits)
                    token_file.write_text("rotated-token\n")
                    executor.submit(job("complete").complete).result(timeout=3)
                    executor.submit(job("cleanup").cleanup).result(timeout=3)
                    assert all(not wait.done() for wait in waits), "Lifecycle calls should finish while waits stay open"

                    # Queueing for the saturated wait pool shares the elapsed
                    # request deadline and must not report a successful False.
                    deployment._timeout_seconds = 0.2
                    queued = executor.submit(job("queued").cancellation_requested, timeout=20)
                    try:
                        queued.result(timeout=3)
                    except (RequestDeadlineExceeded, httpx.PoolTimeout):
                        pass
                    else:
                        raise AssertionError("A queued wait must fail when its request deadline expires")
                    assert not any(name == "queued" for _, name, _, _ in requests)
                    deployment._timeout_seconds = 30
                finally:
                    release.set()
                assert all(wait.result(timeout=3) for wait in waits)
                assert job("rotated-wait").cancellation_requested(timeout=20)
                control_pool = deployment._client.rest_client.pool_manager
                wait_pool = deployment._wait_client.rest_client.pool_manager
            assert control_pool.is_closed and wait_pool.is_closed
            deployment.close()

        for operation, name, token, query in requests:
            expected = "initial-token" if name in started else "rotated-token"
            assert token == f"Bearer {expected}", (operation, name, token)
            if operation == "cancellation":
                assert 0 < int(query["waitMs"][0]) <= 20_000
                assert query["executionId"] == ["00000000-0000-4000-8000-000000000021"]
        assert [(operation, name) for operation, name, _, _ in requests if operation != "cancellation"] == [
            ("outcome", "complete"), ("cleanup", "cleanup")
        ]
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def qualify_cancellation_client_cleanup() -> None:
    deployment = DeploymentContext(api_url="http://localhost", deployment_id="deployment", token_file="unused")
    original_close = deployment._client.close
    failure = RuntimeError("lifecycle close failed")
    try:
        with (
            patch.object(deployment._client, "close", side_effect=failure) as control_close,
            patch.object(deployment._wait_client, "close", wraps=deployment._wait_client.close) as wait_close,
        ):
            try:
                deployment.close()
            except RuntimeError as error:
                assert error is failure
            else:
                raise AssertionError("The original close error must propagate")
            wait_close.assert_awaited_once()
            deployment.close()
            control_close.assert_awaited_once()
    finally:
        run_sync(original_close())

    with DeploymentContext(api_url="http://localhost", deployment_id="deployment", token_file="unused") as deployment:
        selected = SelectedJob(jobId="job", executionId=UUID("00000000-0000-4000-8000-000000000021"))
        for timeout in (-1, 20.1, float("nan"), float("inf")):
            try:
                deployment.cancellation_requested(selected, timeout=timeout)
            except ValueError as error:
                assert "timeout must be finite" in str(error)
            else:
                raise AssertionError("Invalid waits must fail before token or HTTP access")
