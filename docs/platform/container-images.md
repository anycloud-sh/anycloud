---
title: Container Images
description: Choose, build, publish, and optimize container images for Jobs, Services, and VMs.
---

# Container Images

Every Job, Service, and VM runs from a container image. The image defines the
operating system, dependencies, and application code. Anycloud provisions the
VM and runs the image; it does not build the image
for you. `anycloud vm` requires a compatible image supplied by the user;
Anycloud does not provide a default VM image.

## Choose an image workflow

Use a public image when it already contains the runtime you need:

```bash
anycloud job pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime \
  --gpu-type h100 \
  --gpus all \
  -- python -c "import torch; print(torch.cuda.is_available())"
```

Build a custom image for application workloads. Put dependency installation
before source-code copies so Docker can reuse the expensive dependency layers
when only your code changes.

<span id="building-and-pushing"></span>
<span id="build-locally"></span>
<span id="build-in-ci-github-actions"></span>

## Build and publish

A minimal image:

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

CMD ["python", "main.py"]
```

<span id="architecture"></span>

Cloud workload VMs run Linux on x86-64 (`linux/amd64`), except Arm types,
such as AWS Graviton's `m8g` or GCP Axion's `c4a`, which run `linux/arm64`. Build for the VM types you
request, especially on Apple Silicon. A multi-platform image runs on either:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/YOUR_GITHUB_USERNAME/my-app:latest \
  --push .
```

Anycloud refuses an image without a build for the requested architecture
before it starts a VM, and fails the Job if the pull on the VM finds none.

To push to GHCR from your machine, log Docker in with the GitHub CLI. Its
default login doesn't include `write:packages`, so add it first. `gh auth
refresh` fails while `GH_TOKEN` or `GITHUB_TOKEN` is set, so unset them:

```bash
gh auth refresh -s write:packages
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
```

`anycloud login` only reads packages, so it can't push. Public images can come
from any registry; private image authentication currently supports GHCR.

For repeatable builds, publish in CI with the built-in `GITHUB_TOKEN` and
`packages: write`, and tag the image with a commit SHA:

```yaml
name: build-image
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v6
      - run: echo "IMAGE=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v7
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}
```

<span id="gpu-support"></span>

## GPU images

Start from a CUDA, NVIDIA, or framework GPU image that matches the libraries
your application expects. Anycloud prepares GPU access on the host when you
request GPU hardware; the container does not need to install a host driver or
set `--runtime nvidia`.

Building on macOS does not test GPU access. Compile CUDA extensions in a
supported Linux build environment and avoid Docker build steps that require a
live GPU on a CPU-only CI runner.

## Pull and startup behavior

Anycloud resolves the requested reference to a registry digest before the
workload starts. A mutable tag can point to new content, but each workload
pulls the digest resolved for that run.

On supported GPU hosts, the pull path can fetch several ranges of a large layer
concurrently. Unsupported configurations and transfer failures fall back to a
normal Docker pull. No workload flag is required.

Every image byte must reach a new VM before startup. To reduce cold starts:

- Use runtime images instead of development images when compilers are not
  needed at run time.
- Use multi-stage builds and a `.dockerignore`.
- Remove package indexes and build caches in the same layer that creates them.
- Install Python packages with `pip --no-cache-dir`.
- Keep datasets and model weights in [Buckets](/platform/buckets) when their
  lifecycle differs from the application.
- Copy frequently changing source after dependency layers to maximize build
  cache reuse.

Measure compressed registry size and time to first useful work before and after
changes; moving bytes between an image and a Bucket changes when they transfer,
not whether they transfer.

<span id="docker-runtime-options"></span>

## Runtime options

Anycloud passes common container resource settings through to Docker:

```bash
anycloud job ghcr.io/acme/train:latest \
  --shm-size 8g \
  --memory 32g \
  --cpus 4 \
  --ipc host \
  --gpus all
```

See [`job` reference](/reference/cli/job) or
[Configuration](/reference/configuration) for the exact fields.
