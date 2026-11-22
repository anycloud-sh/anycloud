"""Elapsed generated HTTP requests, cancellation cleanup, and client reuse."""

from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

from anycloud.api.workloads_api import WorkloadsApi
from anycloud.api_client import ApiClient
from anycloud.configuration import Configuration
from anycloud.models.workload_resubmit_body import WorkloadResubmitBody
from anycloud.sync_helper import run_sync
from anycloud_workflows._request_deadline import (
    RequestDeadlineExceeded,
    request_with_deadline,
)


def qualify_request_deadlines() -> None:
    slow = threading.Event()
    observed: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            pass

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            assert json.loads(self.rfile.read(length)) == {}
            self.respond({"message": "Resubmitted job-1"})

        def respond(self, payload: dict[str, object]) -> None:
            observed.append(self.path)
            body = json.dumps(payload).encode()
            self.send_response(202)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                if slow.is_set():
                    for offset in range(0, len(body), 4):
                        self.wfile.write(body[offset : offset + 4])
                        self.wfile.flush()
                        time.sleep(0.025)
                else:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client = ApiClient(Configuration(host=f"http://127.0.0.1:{server.server_port}/v1"))
    api = WorkloadsApi(client)
    operations = [
        (api.resubmit_workload, ("job-1", "0.0.0", WorkloadResubmitBody())),
    ]
    try:
        for operation, args in operations:
            slow.set()
            start = time.monotonic()
            try:
                request_with_deadline(operation, *args, deadline=start + 0.15)
            except RequestDeadlineExceeded:
                pass
            else:
                raise AssertionError("Incremental body escaped the elapsed deadline")
            assert time.monotonic() - start < 0.4
            slow.clear()
            result = request_with_deadline(operation, *args, deadline=time.monotonic() + 2)
            assert result.message == "Resubmitted job-1"
        assert any(path.endswith("/workloads/job-1/resubmissions") for path in observed)
    finally:
        run_sync(client.close())
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    cancelled = threading.Event()
    settled = threading.Event()

    async def resists_cancellation(*, _request_timeout: float) -> None:
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.set()
            await asyncio.sleep(0.15)
            settled.set()
            raise ValueError("Late request failure must be consumed")

    start = time.monotonic()
    try:
        request_with_deadline(resists_cancellation, deadline=start + 0.05)
    except RequestDeadlineExceeded:
        pass
    else:
        raise AssertionError("Cancellation-resistant request escaped deadline")
    assert time.monotonic() - start < 0.15
    assert cancelled.wait(1)

    async def succeeds(*, _request_timeout: float) -> int:
        return 42

    assert request_with_deadline(succeeds, deadline=time.monotonic() + 1) == 42
    assert settled.wait(1)
    original = TimeoutError("Original request error")

    async def fails(*, _request_timeout: float) -> None:
        raise original

    try:
        request_with_deadline(fails, deadline=time.monotonic() + 1)
    except TimeoutError as error:
        assert error is original
    else:
        raise AssertionError("Request error was lost")


if __name__ == "__main__":
    qualify_request_deadlines()
