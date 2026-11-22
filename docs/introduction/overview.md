---
slug: /intro
title: Introduction to Anycloud
sidebar_label: Overview
description: Run jobs, services, and persistent VMs across AWS, Azure, GCP, and Lambda.
---

# Anycloud

Anycloud runs containerized jobs, services, and persistent VMs in
your own cloud accounts. Connect AWS, Azure, GCP, or Lambda, choose the hardware
you need, and provision it from one CLI. The Python SDK lets you submit and
monitor Jobs, run Services and VMs, and manage credentials, storage, and other
resources from your application.

```bash
anycloud job pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime \
  --credentials my-aws \
  --gpu-type h100 \
  --gpus all \
  -- python -c "import torch; print(torch.cuda.is_available())"
```

Anycloud provisions a VM, pulls the image, runs the container, streams its
state, and cleans up the VM when a job finishes. Long-running HTTP services use
the same infrastructure but keep a stable public URL. VMs keep a
persistent `/workspace` directory and expose host Docker through a long-running
VM container.

## Find what you need

- **[Primitives](/primitives)** explains the building blocks—Jobs, Services,
  VMs, and Buckets. Use it to choose the right execution and storage model.
- **[Platform](/platform)** covers Container Images, hardware, credentials,
  secrets, spend controls, and notifications. Use it to configure and operate
  the infrastructure behind those primitives.
- **[Examples](/examples)** are complete workloads that start with setup and
  end with a useful result. Use them when you want a pattern to adapt.
- **[Reference](/reference)** documents exact CLI syntax, configuration fields,
  defaults, constraints, and Python SDK APIs. Use it while implementing or
  debugging.

## Why Anycloud

### Use capacity across clouds

The same accelerator can vary significantly in price and availability between
providers and regions. Anycloud can try an ordered set of configurations until
capacity is available, while keeping the workload definition unchanged.

### Make spot recovery practical

Jobs can run on lower-cost spot capacity. Write recoverable state to
`/mnt/checkpoint`; Anycloud periodically syncs it to object storage and restores
it when a replacement VM starts.

### Keep the infrastructure in your account

VMs and buckets stay in your cloud accounts. Cloud credentials are stored
locally and encrypted at rest. Switching providers is a configuration change,
not a rewrite of the workload.

### Operate it from tools and agents

The CLI supports structured output, workload filters, session tags,
per-session spend controls, and read-only database queries. That makes the same
operational surface usable by people, scripts, and coding agents.

## Core building blocks

- A **[Job](/platform/jobs)** is finite work that exits when it is done.
- A **[Service](/platform/services)** is a long-running HTTP workload with a
  public URL.
- A **[VM](/platform/vms)** is one cloud host with a persistent container,
  interactive shell, and host Docker access.
- A **[Bucket](/platform/buckets)** makes object storage available inside a
  container as local files.
- A **[Container Image](/platform/container-images)** defines the workload's
  operating system, dependencies, and optional application code.

## Choose a primitive for an AI workload

| Workload                                                 | Primitive                                    | Why                                                             |
| -------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| Pretraining, fine-tuning, or reinforcement learning      | [Job](/platform/jobs)                        | Finite GPU work with automatic cleanup and checkpoint recovery  |
| Batch inference, embeddings, evaluation, or data prep    | [Job](/platform/jobs)                        | Releases compute when the batch exits                           |
| Hyperparameter sweeps or independent experiments         | Parallel [Jobs](/platform/jobs#compose-jobs) | Submit independent Jobs and coordinate them in your application |
| Online inference API, internal endpoint, or model demo   | [Service](/platform/services)                | Keeps an HTTP workload online at a stable URL                   |
| Notebook, interactive debugging, or a mutable dev box    | [VM](/platform/vms)                          | Provides SSH and a persistent `/workspace` for the VM lifetime  |
| Datasets, model artifacts, outputs, or recoverable state | [Bucket](/platform/buckets)                  | Keeps data durable independently of compute                     |

The short rule is: if it finishes, use a Job; if it serves HTTP continuously,
use a Service; if you need to work directly on the machine, use a VM. Buckets
support all three by keeping data outside the compute lifecycle.

Jobs support independent parallelism and single-host multi-GPU workloads.
Tightly coupled multi-node training still needs workload-level orchestration.
Services are persistent single-replica endpoints, not an autoscaling or
high-availability inference platform, and upgrades currently have downtime.

[Get started with your first workload →](/getting-started)
