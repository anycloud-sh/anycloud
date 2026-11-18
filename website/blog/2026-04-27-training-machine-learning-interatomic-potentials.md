---
title: Training Machine Learning Interatomic Potentials on Cloud GPUs
description: A practical guide to training MLIPs (MACE, NequIP, CHGNet, MACE-MP) on cloud GPUs — architecture choices, honest cost ranges, spot-recovery patterns, and a working example.
slug: training-machine-learning-interatomic-potentials
tags: [mlip, mace, machine-learning, gpu, materials-science]
---

Machine learning interatomic potentials (MLIPs) are replacing classical force fields in many computational chemistry applications, reducing simulation times from weeks of DFT compute to minutes on a single GPU. This post is a practical guide to training your own MLIP on cloud GPU spot instances: which architecture to pick, what it actually costs, and how to keep training going through preemption.

<!-- truncate -->

## Why this matters now

Three things changed in the last two years that turned MLIPs from a research tool into a production one:

**Foundation models exist now.** MACE-MP-0 (Jan 2024) was trained on the Materials Project's MPtrj dataset of ~1.6M structures across 89 elements. CHGNet (Sep 2023, Nature Machine Intelligence) and GNoME (Nov 2023, Nature, DeepMind) followed. You can fine-tune these on a few hundred molecules of your own data instead of generating millions of DFT calculations from scratch.

**NVIDIA shipped CUDA kernels specifically for them.** [`cuEquivariance`](https://developer.nvidia.com/blog/accelerate-drug-and-material-discovery-with-new-math-library-nvidia-cuequivariance/) (Nov 2024) accelerates the equivariant operations in MACE foundation models — NVIDIA reports 5.9x training and 5.9x inference speedup for MACE-MP Large on A100. NVIDIA only ships kernels for workloads it expects to see serious commercial adoption.

**Adoption is real.** The Materials Project hosts MLIP-derived datasets, the CederGroup at Berkeley ships CHGNet as a pre-trained universal potential, and a growing wave of biotech, battery, and materials startups now run MLIP-driven simulations as part of their core pipeline.

## What is a machine learning interatomic potential?

A machine learning interatomic potential — sometimes called a neural network potential (NNP) — is a neural network that predicts the potential energy of a system of atoms, and by differentiation the forces on each atom, given only their positions and chemical identities. Train one accurately, and you can run molecular dynamics simulations or geometry optimizations at a tiny fraction of the cost of solving the underlying quantum mechanics directly.

The reference physics is density functional theory (DFT) — the workhorse of computational chemistry since the 1990s. DFT scales O(N³) with the number of electrons; a 200-atom simulation that takes minutes per step in DFT can take milliseconds per step with a trained MLIP. Run a million-step molecular dynamics trajectory and the difference compounds: weeks of supercomputer time become hours on a single GPU.

The history matters because architecture choice still does:

**2007 — Behler-Parrinello neural networks.** The first MLIPs to scale to real systems, using hand-crafted symmetry functions to encode atomic environments. "BPNN" is still a term you'll see in benchmarks today.

**2017–2022 — equivariance era.** SchNet (2017), PaiNN, NequIP (2021), MACE (2022). Instead of hand-crafting rotational invariance, these architectures bake it into the network through equivariant message passing. Accuracy jumped sharply, especially on small training sets.

**2023–2024 — foundation models.** Universal MLIPs trained on huge crystal-structure datasets. MACE-MP-0, CHGNet, GNoME. You don't always need to train from scratch; you can fine-tune a foundation model on a few hundred examples of your specific chemistry.

The industry pattern that emerged: train (or fine-tune) once on cloud GPUs, ship the resulting model file (typically 10–500MB), run inference cheaply on local hardware or smaller cloud instances. The training-time cost is the lever — get it right and the rest follows.

## The architecture landscape: MACE, NequIP, CHGNet, GNoME, MACE-MP

Five architectures dominate practical use today.

| Architecture  | Year                | Architecture type                                 | Pre-training data                   | When to choose                                                                                              |
| ------------- | ------------------- | ------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **MACE**      | 2022                | Higher-order equivariant message passing          | Train on your own data              | Best accuracy/cost tradeoff for a custom potential. Default pick.                                           |
| **NequIP**    | 2021                | E(3) equivariant message passing                  | Train on your own data              | Slightly less accurate than MACE in published benchmarks; well-supported reference                          |
| **CHGNet**    | Sep 2023            | Graph network with magnetic-moment regularization | 1.5M+ MPtrj structures              | Charge-informed; good when magnetic information matters                                                     |
| **GNoME**     | Nov 2023 (DeepMind) | Graph network                                     | Materials Project + active learning | Materials discovery (used to find 381K new stable crystals from 2.2M candidates); weights publicly released |
| **MACE-MP-0** | Jan 2024            | Higher-order equivariant message passing          | ~1.6M MPtrj structures, 89 elements | Universal foundation — fine-tune for any chemistry, fastest path to a working potential                     |

MACE and NequIP are typically trained from scratch on a user's own DFT calculations (hundreds to tens of thousands of configurations). The foundation-model rows show what was used for pre-training — your fine-tuning data sits on top.

**Practical rules of thumb:**

If you have ≥10K of your own DFT calculations, **train a custom MACE** from scratch. You'll get the best accuracy on your specific chemistry. Expect 12–48 hours on a single A100 for typical configurations.

If you have a few hundred to a few thousand DFT calculations, **fine-tune MACE-MP-0**. This is now a common pattern — leveraging the 1.6M-structure pre-training of the foundation model means your fine-tuning run converges in 1–6 hours, often on a single GPU.

If you're doing materials discovery (screening crystal candidates rather than detailed dynamics), **try GNoME or CHGNet first** — they're already trained on broad materials datasets and may not need fine-tuning at all.

The **MPtrj dataset** that MACE-MP-0 and CHGNet were trained on deserves separate mention: ~1.6M structures with energies, forces, stresses, and (for CHGNet) magnetic moments, derived from Materials Project relaxation trajectories. If you're building your own pre-training corpus, MPtrj is the reference benchmark you'll want to compare against.

A note on speed: NVIDIA's `cuEquivariance` library (Nov 2024) accelerates the costly tensor-product operations in MACE. Per NVIDIA's published benchmarks (A100, batch size 32, FP64): 5.9x training and 5.9x inference on MACE-MP Large; 6.1x training and 7.2x inference on MACE-OFF Large. If you're running on H100s or B200s, install cuEquivariance — the speedup is essentially free.

## What it costs to train

A single MLIP training run on cloud GPUs costs somewhere between **a few dollars and a few hundred**, depending almost entirely on three choices.

**The three cost levers:**

1. **Train from scratch vs. fine-tune a foundation model.** Fine-tuning MACE-MP-0 on a few hundred molecules: typically 1–6 hours on a single A100. From-scratch training on a custom dataset: 12–48 hours on a single A100, often longer for production-grade potentials.

2. **Spot vs. on-demand instance pricing.** A100 80GB spot prices currently start around $0.78/hour at the cheapest specialty providers (Thunder Compute) and run to $1.50–$2.00/hour at most spot marketplaces (Vast.ai, RunPod, similar); on-demand at major hyperscalers runs $3–$5/hour per A100. Spot is the right default for MLIP training — the workload checkpoints cleanly and most preemption recoveries cost minutes, not hours.

3. **GPU class.** A100 (40GB or 80GB) is the workhorse and the recommended default. H100 trains noticeably faster on equivariant architectures with cuEquivariance; whether the speed-up justifies the ~3x price-per-hour depends on how time-sensitive the run is. B200s are now available at multiple providers but are usually overkill for MLIP training; the bottleneck shifts to data-loading rather than compute.

**Practical cost ranges by workload (estimates derived from spot rates above and typical wall-clock times; not measurements):**

| Workload                         | Hardware | Wall-clock  | Spot cost     | On-demand cost |
| -------------------------------- | -------- | ----------- | ------------- | -------------- |
| Fine-tune MACE-MP, 100 molecules | 1× A100  | 1–2 hours   | **$1–$3**     | $4–$8          |
| Fine-tune MACE-MP, 1K molecules  | 1× A100  | 4–8 hours   | **$3–$12**    | $16–$32        |
| Train custom MACE, 10K configs   | 1× A100  | 24–48 hours | **$20–$70**   | $80–$200       |
| Train custom MACE, 100K configs  | 4× A100  | 48–72 hours | **$120–$430** | $640–$1700     |

These are training-only numbers. Add 15–30% if you're including hyperparameter sweeps. Add ~5% for storage (training data + checkpoint buckets typically run a few cents per GB-month).

**Where multi-cloud matters:** A100 spot capacity is often unavailable in any single region for hours at a time. Spreading submissions across AWS, GCP, and Azure when capacity is short drops effective queue time. For a training run that takes 24 hours of compute but spends another 12 hours queued, the cost-effective answer is whichever cloud has capacity right now — not whichever has the cheapest sticker price. anycloud today optimizes region selection within the cloud associated with the selected `--credentials`; choosing across clouds from a single submission remains manual.

## The spot-recovery problem

Spot instances are typically 3–5x cheaper than on-demand. For a 24-hour MLIP training run, that's the difference between $20 and $80. The catch: spot VMs can be reclaimed with short notice — AWS gives 2 minutes, GCP gives 30 seconds, Azure varies. You need a recovery story that doesn't lose your training progress.

**What MLIP training needs from a recovery system:**

1. **Frequent, durable checkpointing.** MACE and most modern MLIP trainers checkpoint at the end of each epoch. For a 1000-epoch training run with 10-second epochs, that's a checkpoint every 10 seconds. Each checkpoint is typically tens to hundreds of MB. Writing locally is fast; getting the checkpoint _off_ the VM before it's reclaimed is the hard part.

2. **Automatic resume from the latest checkpoint.** When the new VM provisions, the trainer needs to find the most recent checkpoint without manual intervention. MACE's `mace_run_train` supports `--restart_latest` to read from a checkpoint directory automatically.

3. **Cross-region fallback.** If your spot VM gets preempted in `us-east-1`, the next instance might come up in `us-west-2`. The checkpoint storage needs to be region-agnostic (object storage works; local SSD doesn't), and the training environment needs to come up identically wherever the new VM lands. Cross-cloud fallback (preempted on AWS, resume on GCP) is a stronger version of the same idea, useful when one cloud's spot pool is fully starved.

4. **Image caching.** Pulling a large MLIP container (typically 5–15GB with CUDA + PyTorch + mace-torch + dependencies) takes several minutes from scratch. Each preemption that triggers a re-pull eats into the cost savings. Per-region image caching gets the second launch down to seconds.

Realistic options today: SkyPilot handles managed spot lifecycle and cross-cloud fallback well; Slurm with cluster autoscaling works for HPC-shop teams; PyTorch Lightning can do checkpointing-to-S3 with custom configuration; or use a system that bundles points 1, 3, and 4 by default — anycloud's `--spot` flag does this with container-as-unit-of-work rather than YAML configuration. (Point 2, automatic resume, is the trainer's job — MACE provides `--restart_latest` for exactly this.)

The cost of getting this wrong: a single missed checkpoint on a 24-hour training run can waste 12 hours of A100 time — $20–$80 of compute, plus a day of calendar time. Multiply that by the 5–10 training runs a typical research group submits per week, and the engineering investment in good spot recovery pays for itself within a month.

## Worked example: training MACE on cloud spot

Here's a command to fine-tune MACE-MP on a small molecular dataset using AWS spot. Substitute the `--credentials` value with a named credential you imported or entered using `anycloud credentials new`:

```bash
anycloud job ghcr.io/anycloud-sh/mace:latest \
  --credentials my-aws \
  --gpu-type a100 \
  --spot \
  --disk-size 200 \
  --input-bucket my-training-data \
  --output-bucket my-results \
  --gpus all \
  -- mace_run_train \
    --name=my_finetune \
    --foundation_model=medium \
    --train_file=/mnt/input/train.xyz \
    --valid_fraction=0.1 \
    --max_num_epochs=200 \
    --batch_size=16 \
    --lr=0.001 \
    --device=cuda \
    --checkpoints_dir=/mnt/checkpoint \
    --restart_latest \
    --results_dir=/mnt/output
```

What that does, in plain terms:

- Pulls the MACE container (CUDA 12.4, PyTorch, `mace-torch`)
- Picks the best-priced A100 spot region within the cloud associated with `--credentials`
- Mounts your training data bucket at `/mnt/input` and a checkpoint bucket at `/mnt/checkpoint` (auto-created when `--spot` is set)
- Runs MACE's `mace_run_train` with `--foundation_model=medium` to fine-tune from MACE-MP, and `--restart_latest` so the trainer resumes from the most recent checkpoint after any preemption
- Writes the trained model and logs to your output bucket

If the spot VM gets preempted partway through, anycloud provisions a new VM (potentially in a different region of the same cloud), restores the checkpoint directory, and `mace_run_train` picks up from where it left off. To cover the case where one cloud's spot pool is fully starved, submit the same job in parallel against credentials for a second cloud — whichever one acquires capacity first runs to completion.

The Python SDK equivalent is the same shape — see [Train MACE on spot GPUs](/examples/train-mace) for the complete CLI and SDK workflow.

## Fine-tuning MACE-MP from a foundation model

Fine-tuning MACE-MP-0 from the foundation model is now a common pattern. The foundation model has already learned the general physics of 89 elements from ~1.6M structures in MPtrj. Your fine-tuning data only needs to teach it the specific chemistry of your system.

**When fine-tuning beats from-scratch:**

- **You have under 5K of your own DFT calculations.** From-scratch training on small datasets typically gives noisy potentials with poor extrapolation; fine-tuning gives you the foundation model's broad coverage with your domain-specific accuracy.
- **Your chemistry overlaps with the MPtrj distribution.** Most main-group inorganic systems do; some organic chemistry doesn't (MPtrj is crystal-biased). Check your element coverage before assuming foundation-model fine-tuning will work.
- **You need a usable model fast.** Fine-tuning runs converge in 1–6 hours; from-scratch runs take 12–48.

The MACE foundation models are released at three sizes (`small`, `medium`, `large`). `medium` is the typical workhorse — fits comfortably on a single A100 with reasonable batch sizes.

```bash
anycloud job ghcr.io/anycloud-sh/mace:latest \
  --credentials my-aws \
  --gpu-type a100 \
  --spot \
  --input-bucket my-training-data \
  --output-bucket my-results \
  --gpus all \
  -- mace_run_train \
    --name=finetune_mp_medium \
    --foundation_model=medium \
    --train_file=/mnt/input/finetune.xyz \
    --max_num_epochs=100 \
    --lr=0.0001 \
    --device=cuda \
    --checkpoints_dir=/mnt/checkpoint \
    --restart_latest \
    --results_dir=/mnt/output
```

Two flags worth noting: `--lr=0.0001` (an order of magnitude lower than from-scratch training — fine-tuning needs gentler updates to preserve foundation-model knowledge) and `--max_num_epochs=100` (most fine-tuning runs converge well before this).

## Further reading

- [MACE](https://github.com/ACEsuit/mace) — the reference implementation
- [MACE-MP foundation models](https://github.com/ACEsuit/mace-foundations) on GitHub, weights on Hugging Face
- [MACE fine-tuning docs](https://mace-docs.readthedocs.io/en/latest/guide/finetuning.html) — `--foundation_model` flag and multi-head fine-tuning
- [NVIDIA cuEquivariance](https://developer.nvidia.com/blog/accelerate-drug-and-material-discovery-with-new-math-library-nvidia-cuequivariance/) — CUDA kernels for equivariant networks
- [Train MACE on spot GPUs](/examples/train-mace) — runnable end-to-end with Python SDK and CLI variants
- [Angstrom (YC S24) used agentic loops to train a model that beat Meta's UMA-OMC](/blog/angstrom-case-study) — this pattern at a scale of more than 100,000 GPU-hours for crystal structure prediction
