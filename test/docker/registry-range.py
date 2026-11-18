#!/usr/bin/env python3
"""Read an exact byte range from an OCI registry blob.

Authentication follows the Docker registry bearer challenge and reuses the
credentials from Docker's configured auth file or credential helper. Refusing
a 200 response is intentional: a registry that ignores Range must not make a
small TOC check download an entire multi-gigabyte layer.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def origin(url: str) -> tuple[str, str, int | None]:
    parsed = urllib.parse.urlsplit(url)
    default_port = (
        443 if parsed.scheme == "https" else 80 if parsed.scheme == "http" else None
    )
    return (
        parsed.scheme.lower(),
        (parsed.hostname or "").lower(),
        parsed.port or default_port,
    )


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Preserve byte ranges but never forward credentials to another origin."""

    def redirect_request(  # type: ignore[override]
        self,
        request: urllib.request.Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> urllib.request.Request | None:
        redirected = super().redirect_request(
            request, file_pointer, code, message, headers, new_url
        )
        if redirected is None:
            return None
        if request.has_header("Range") and not redirected.has_header("Range"):
            redirected.add_header("Range", request.get_header("Range"))
        if origin(request.full_url) != origin(new_url):
            redirected.remove_header("Authorization")
        return redirected


OPENER = urllib.request.build_opener(SafeRedirectHandler())


def parse_reference(reference: str) -> tuple[str, str]:
    value = reference.removeprefix("https://").removeprefix("http://")
    value = value.split("@", 1)[0]
    first, separator, remainder = value.partition("/")
    if not separator:
        return "registry-1.docker.io", f"library/{first.split(':', 1)[0]}"
    if "." in first or ":" in first or first == "localhost":
        registry, repository = first, remainder
    else:
        registry, repository = "registry-1.docker.io", value
    repository = repository.rsplit(":", 1)[0]
    if not repository:
        raise ValueError(f"image reference has no repository: {reference}")
    return registry, repository


def docker_config() -> dict[str, object]:
    directory = Path(os.environ.get("DOCKER_CONFIG", Path.home() / ".docker"))
    path = directory / "config.json"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def credential_from_helper(helper: str, registry: str) -> tuple[str, str] | None:
    try:
        result = subprocess.run(
            [f"docker-credential-{helper}", "get"],
            input=f"{registry}\n",
            text=True,
            capture_output=True,
            check=True,
            timeout=10,
        )
        payload = json.loads(result.stdout)
        return str(payload["Username"]), str(payload["Secret"])
    except (
        FileNotFoundError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        KeyError,
        json.JSONDecodeError,
    ):
        return None


def docker_credential(registry: str) -> tuple[str, str] | None:
    config = docker_config()
    helpers = config.get("credHelpers", {})
    if isinstance(helpers, dict) and isinstance(helpers.get(registry), str):
        found = credential_from_helper(str(helpers[registry]), registry)
        if found:
            return found

    auths = config.get("auths", {})
    if isinstance(auths, dict):
        candidates = [registry, f"https://{registry}", f"https://{registry}/v1/"]
        for key in candidates:
            entry = auths.get(key)
            if not isinstance(entry, dict):
                continue
            identity_token = entry.get("identitytoken")
            if isinstance(identity_token, str) and identity_token:
                return "<token>", identity_token
            encoded = entry.get("auth")
            if isinstance(encoded, str) and encoded:
                try:
                    decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
                except (ValueError, UnicodeDecodeError):
                    continue
                if ":" in decoded:
                    username, secret = decoded.split(":", 1)
                    return username, secret

    store = config.get("credsStore")
    if isinstance(store, str) and store:
        return credential_from_helper(store, registry)
    return None


def authorization_basic(credential: tuple[str, str] | None) -> str | None:
    if not credential or credential[0] == "<token>":
        return None
    encoded = base64.b64encode(f"{credential[0]}:{credential[1]}".encode()).decode()
    return f"Basic {encoded}"


def parse_bearer_challenge(value: str) -> dict[str, str]:
    if not value.lower().startswith("bearer "):
        raise RuntimeError(
            f"registry returned an unsupported auth challenge: {value!r}"
        )
    return {
        key.lower(): parsed for key, parsed in re.findall(r'(\w+)="([^"]*)"', value[7:])
    }


def bearer_token(
    challenge: str,
    repository: str,
    credential: tuple[str, str] | None,
) -> str:
    fields = parse_bearer_challenge(challenge)
    realm = fields.get("realm")
    if not realm:
        raise RuntimeError("registry bearer challenge did not include a realm")
    query = urllib.parse.urlencode(
        {
            "service": fields.get("service", ""),
            "scope": fields.get("scope", f"repository:{repository}:pull"),
        }
    )
    request = urllib.request.Request(f"{realm}?{query}")
    basic = authorization_basic(credential)
    if basic:
        request.add_header("Authorization", basic)
    with OPENER.open(request, timeout=30) as response:
        payload = json.load(response)
    token = payload.get("token") or payload.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("registry token service returned no token")
    return token


def open_range(
    url: str,
    offset: int,
    length: int,
    authorization: str | None,
) -> object:
    request = urllib.request.Request(url)
    request.add_header("Range", f"bytes={offset}-{offset + length - 1}")
    request.add_header("Accept-Encoding", "identity")
    if authorization:
        request.add_header("Authorization", authorization)
    return OPENER.open(request, timeout=60)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference")
    parser.add_argument("digest")
    parser.add_argument("offset", type=int)
    parser.add_argument("length", type=int)
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.digest):
        parser.error("digest must be sha256:<64 lowercase hex characters>")
    if args.offset < 0 or args.length <= 0:
        parser.error("offset must be non-negative and length must be positive")

    registry, repository = parse_reference(args.reference)
    url = f"https://{registry}/v2/{repository}/blobs/{args.digest}"
    try:
        response = open_range(url, args.offset, args.length, None)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
        challenge = error.headers.get("WWW-Authenticate", "")
        used_credentials = False
        try:
            # Public registries commonly issue an anonymous pull token. Avoid
            # invoking a desktop credential helper unless the token endpoint
            # proves credentials are necessary; helpers may prompt or block.
            token = bearer_token(challenge, repository, None)
        except urllib.error.HTTPError as token_error:
            if token_error.code not in {401, 403}:
                raise
            credential = docker_credential(registry)
            if not credential:
                raise RuntimeError(
                    f"registry credentials are required for {registry}"
                ) from token_error
            if credential[0] == "<token>":
                token = credential[1]
            else:
                token = bearer_token(challenge, repository, credential)
            used_credentials = True
        try:
            response = open_range(url, args.offset, args.length, f"Bearer {token}")
        except urllib.error.HTTPError as blob_error:
            # Some private registries issue an anonymous token successfully but
            # reject that token on the blob endpoint. Only then consult Docker
            # credentials and exchange a pull token with those credentials.
            if used_credentials or blob_error.code not in {401, 403}:
                raise
            credential = docker_credential(registry)
            if not credential:
                raise RuntimeError(
                    f"registry credentials are required for {registry}"
                ) from blob_error
            if credential[0] == "<token>":
                token = credential[1]
            else:
                token = bearer_token(challenge, repository, credential)
            response = open_range(url, args.offset, args.length, f"Bearer {token}")

    with response:
        status = response.getcode()
        if status != 206:
            raise RuntimeError(
                f"registry ignored byte range (HTTP {status}); refusing full blob download"
            )
        expected_prefix = f"bytes {args.offset}-{args.offset + args.length - 1}/"
        content_range = response.headers.get("Content-Range", "")
        if not content_range.startswith(expected_prefix):
            raise RuntimeError(f"unexpected Content-Range: {content_range!r}")
        payload = response.read(args.length + 1)

    if len(payload) != args.length:
        raise RuntimeError(
            f"registry returned {len(payload)} bytes; expected exactly {args.length}"
        )
    sys.stdout.buffer.write(payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"registry-range: {error}", file=sys.stderr)
        raise SystemExit(1) from error
