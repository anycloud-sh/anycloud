"""Inspect built SDK archives without importing from the source tree."""

from __future__ import annotations

import sys
import tarfile
import zipfile
from pathlib import Path


HANDWRITTEN_MODULES = {
    "client.py",
    "current_deployment.py",
    "deployment_jobs.py",
    "deployments.py",
    "errors.py",
    "job.py",
    "job_group.py",
    "storage.py",
    "types.py",
}
FORBIDDEN_SUFFIXES = {".jar", ".openapi-generator-ignore"}


def normalized_members(archive: Path) -> list[str]:
    if archive.suffix == ".whl":
        with zipfile.ZipFile(archive) as package:
            return package.namelist()
    with tarfile.open(archive, "r:gz") as package:
        return package.getnames()


def qualify(archive: Path) -> None:
    members = normalized_members(archive)
    assert members, f"{archive} is empty"
    if archive.suffix == ".whl":
        assert "anycloud/__init__.py" in members, archive
        assert "anycloud/py.typed" in members, archive
        assert any(name.startswith("anycloud/api/") for name in members), archive
        assert any(name.startswith("anycloud/models/") for name in members), archive
        assert "anycloud_workflows/__init__.py" in members, archive
        assert "anycloud_workflows/py.typed" in members, archive
        assert "anycloud_workflows/workloads.py" in members, archive
        assert "anycloud_workflows/jobs.py" in members, archive
        assert "anycloud_workflows/async_jobs.py" in members, archive
        assert "anycloud_workflows/_request_deadline.py" in members, archive
        for name in ("LICENSE", "NOTICE"):
            assert any(
                member.endswith(f".dist-info/licenses/{name}") for member in members
            ), name
        with zipfile.ZipFile(archive) as package:
            metadata_name = next(
                name for name in members if name.endswith(".dist-info/METADATA")
            )
            metadata = package.read(metadata_name).decode("utf8")
        for requirement in {
            "Requires-Python: >=3.10",
            "Requires-Dist: httpx<1,>=0.28.1",
            "Requires-Dist: pydantic<3,>=2.11",
            "Requires-Dist: python-dateutil<3,>=2.8.2",
            "Requires-Dist: typing-extensions<5,>=4.12.2",
        }:
            assert requirement in metadata, requirement
    else:
        assert any(name.endswith("/LICENSE") for name in members)
        assert any(name.endswith("/NOTICE") for name in members)
        assert any(name.endswith("/generated/anycloud/__init__.py") for name in members)
        assert any(name.endswith("/package-data/anycloud/py.typed") for name in members)
        assert any(name.endswith("/examples/job_completion.py") for name in members)
        assert any("/generated/anycloud/api/" in name for name in members)
        assert any("/generated/anycloud/models/" in name for name in members)
        assert any(
            name.endswith("/extensions/anycloud_workflows/__init__.py")
            for name in members
        )
        assert any(
            name.endswith("/extensions/anycloud_workflows/py.typed")
            for name in members
        )
        assert any(
            name.endswith("/extensions/anycloud_workflows/workloads.py")
            for name in members
        )
        assert any(
            name.endswith("/extensions/anycloud_workflows/jobs.py")
            for name in members
        )
        assert any(
            name.endswith("/extensions/anycloud_workflows/async_jobs.py")
            for name in members
        )
        assert any(
            name.endswith("/extensions/anycloud_workflows/_request_deadline.py")
            for name in members
        )

    for name in members:
        path = Path(name)
        assert "worker" not in path.name.lower(), name
        assert path.name not in HANDWRITTEN_MODULES, name
        assert path.suffix not in FORBIDDEN_SUFFIXES, name
        assert "__pycache__" not in path.parts, name
        assert ".openapi-generator" not in path.parts, name
        assert not name.endswith("openapi.json"), name


def main() -> None:
    archives = [Path(argument) for argument in sys.argv[1:]]
    assert len(archives) == 2, "pass exactly one wheel and one sdist"
    assert sum(path.suffix == ".whl" for path in archives) == 1
    assert sum(path.name.endswith(".tar.gz") for path in archives) == 1
    for archive in archives:
        qualify(archive)


if __name__ == "__main__":
    main()
