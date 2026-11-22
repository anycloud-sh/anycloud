---
title: Catalog and pricing
description: Exact syntax for browsing images, regions, VM types, GPUs, and cloud prices.
---

# Catalog and pricing

Interactive terminals open pickers when positional values are omitted.
Non-interactive calls must supply the required cloud, region, or type.
`--json` never opens a picker.

## `anycloud images`

Browse images in GitHub Container Registry. Alias: `anycloud imgs`.

```bash
anycloud images [options]
```

| Option              | Description                                 |
| ------------------- | ------------------------------------------- |
| `-f, --filter TEXT` | Filter image, owner, package, or tag        |
| `--owner OWNER`     | Restrict to one GitHub user or organization |
| `--list`            | Print packages and tags instead of a picker |
| `--no-tags`         | Skip per-package tag lookup                 |
| `--json`            | Compact JSON                                |
| `--only-refs`       | One full `ghcr.io/owner/image:tag` per line |

`--only-refs` requires tag lookup and cannot be combined with `--no-tags`.
Machine output goes to stdout; progress and warnings go to stderr.

## `anycloud regions`

```bash
anycloud regions [cloud] [--vm-type TYPE] [--spot] [--json]
```

Cloud values are `aws`, `gcp`, `azure`, and `lambda`.

| Option           | Description                                  |
| ---------------- | -------------------------------------------- |
| `--vm-type TYPE` | Only regions offering the VM, cheapest first |
| `--spot`         | Use spot prices in the VM sort               |
| `--json`         | JSON array                                   |

```bash
anycloud regions aws --vm-type p5.48xlarge --spot
```

## `anycloud vm-types`

```bash
anycloud vm-types [cloud] [region] [--accelerator GPU] [--details] [--json]
```

| Option              | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `--accelerator GPU` | Only VM types with the accelerator                                     |
| `--json`            | JSON array of names, or records with `--details`                       |
| `--details`         | CPU, RAM, accelerators, regional prices, quota group, and capabilities |

In non-interactive use, pass both cloud and region.

```bash
anycloud vm-types aws us-east-1 --details --json
```

Detailed records contain `vmType`, the selected `region`, `vCPUs`, `memoryGiB`,
`accelerators` (name and count), `quotaGroup`, `capabilities`, and `regions`.
Each regional offering has `region`, `onDemandPricePerHour`, and
`spotPricePerHour`; GCP offerings use placement zones with parent-region prices.
`capabilities.nestedVirtualization` describes support in the selected region,
and `capabilities.premiumStorage` describes reported storage support. Missing
values are `null`, including capabilities absent from older catalogs. An empty
accelerator array means a known CPU-only type; `null` means unknown accelerator
information. Without `--details`, output remains a list of names.

AWS catalog refresh enriches upstream offerings with processor capabilities in
regions enabled for its publishing identity; other regions remain unknown. AWS
VMs launch with nested virtualization enabled when the catalog reports support
for their type in that region, so KVM tools such as Local SmolVM run inside
them. GCP and Azure don't report it, so their catalogs record it from a
reviewed list of machine series, and other series remain unknown. On GCP a
region reports support when any of its zones does. VM Jobs submitted with
`--require-nested-virtualization` keep only the VM types the catalog reports support for, and launch them with
it on, on every cloud.

## `anycloud gpus`

List accelerator offerings and prices:

```bash
anycloud gpus [cloud] [--type GPU] [--json]
anycloud gpus --type GPU [--count N] [--spot] [--json]
```

| Option       | Description                                                                  |
| ------------ | ---------------------------------------------------------------------------- |
| `--type GPU` | One SKU, such as `H100`; required for non-interactive cross-cloud comparison |
| `--count N`  | GPU count for cross-cloud comparison                                         |
| `--spot`     | Sort cross-cloud results by spot; fall back to on-demand where absent        |
| `--json`     | JSON array                                                                   |

```bash
anycloud gpus aws
anycloud gpus gcp --type H100
anycloud gpus --type H100 --count 8 --spot
```

## `anycloud pricing`

Look up one VM type across regions, or in a specific region:

```bash
anycloud pricing [cloud] [vm-type] [--region REGION] [--spot] [--json]
```

| Option            | Description                             |
| ----------------- | --------------------------------------- |
| `--region REGION` | Restrict to one region                  |
| `--spot`          | Return spot rather than on-demand price |
| `--json`          | JSON object                             |

Non-interactive use requires cloud and VM type.
