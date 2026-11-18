---
slug: /primitives
title: Primitives
description: Choose Jobs, Services, VMs, and Buckets based on workload lifecycle, access, and persistence.
---

# Primitives

Jobs, Services, and VMs are the three Workload types, and Buckets provide
storage that persists independently of compute. Choose the resources that match your
workload's lifecycle and access needs.

| Primitive                     | Choose it when                       | Lifetime                     | Primary access                             |
| ----------------------------- | ------------------------------------ | ---------------------------- | ------------------------------------------ |
| [Job](/platform/jobs)         | Work should run to completion        | Until a terminal outcome     | Status; logs and `exec` for VM-backed Jobs |
| [Service](/platform/services) | An HTTP workload should stay online  | Until upgrade or termination | Stable public URL                          |
| [VM](/platform/vms)           | You need direct, interactive control | Until termination            | SSH to the container or host               |
| [Bucket](/platform/buckets)   | Data must outlive its compute        | Until the bucket is deleted  | Mounted files in supported workloads       |

Jobs are the default for finite work such as training, evaluation, and batch
inference. Services manage long-running HTTP workloads and give them a stable
public URL. VMs provide an interactive shell and direct host control without a
managed HTTP endpoint. Buckets complement supported Jobs and Services with
durable object storage; they are not a compute environment.

Jobs, Services, and VMs each run on dedicated VMs. Workload is the shared
record for all three.
