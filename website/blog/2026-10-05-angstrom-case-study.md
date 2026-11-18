---
title: 'How Ångström used Anycloud to beat Meta in AI crystal structure prediction'
description: Ångstrom AI (YC S24), with Cambridge and AstraZeneca, used anycloud and agents to develop CSP-MACE-Å across 100,000+ GPU hours. The model outperformed Meta's UMA-OMC model.
slug: angstrom-case-study
authors: [luis, laurence]
tags: [case-study, mlip, csp, crystal-structure-prediction, angstrom, agents]
---

import { SpendControlsCarousel, SlackNotificationsCarousel } from '@site/src/components/AngstromCaseStudyVisuals';

[Ångstrom AI](https://www.angstrom-ai.com) (YC S24), with the University of Cambridge (the Csanyi group) and AstraZeneca, released [_DFT Accuracy on Crystal Structure Prediction with Machine Learning Interatomic Potentials_](https://arxiv.org/abs/2605.28905). The paper presented **CSP-MACE-Å**, a machine learning model designed to match DFT accuracy in crystal structure prediction while running 10,000 times faster.

CSP-MACE-Å also significantly outperformed **UMA-OMC** on crystal-structure prediction benchmarks. UMA is Meta's general-purpose model for atoms and molecules; UMA-OMC is the version adapted for organic molecular crystals.

Ångstrom built CSP-MACE-Å on anycloud, a CLI that runs GPU workloads across your own cloud accounts. The team ran more than **100,000 GPU hours**, almost entirely on spot capacity across multiple clouds. Researchers also used agents through the same `anycloud` CLI to launch and monitor batches, retrieve results, and help drive the experiment loop.

<!-- truncate -->

## Why crystal structure prediction matters

Crystal structure prediction (CSP) answers a deceptively simple question: given a molecule, what solid crystal structures can it form? It matters because one molecule can pack into different crystal structures (known as polymorphs) with different physical characteristics. This creates a major risk for pharmaceutical development, especially when late-appearing forms emerge during manufacturing or storage and alter product performance. In 1998, that nearly sank the HIV drug ritonavir. The drug had to be pulled and reformulated when an unexpected, more stable crystal form of the same molecule appeared two years after market release. This cost Abbott more than $250 million. Veritasium tells the story well in its [_The Crystal That Could Destroy All Medicine_](https://www.youtube.com/watch?v=ksn5yrsC3Wg) video. Drugmakers must map all possible crystal forms before release to reduce the risk that a more stable form appears later and renders an already-distributed drug unusable.

The workhorse of CSP is **DFT** (density functional theory). DFT is a quantum-mechanical calculation that serves as the gold standard for CSP in industry and academia. However, DFT is extremely expensive and slow. The calculations for one molecule can take days to weeks, slowing scientists down and limiting how many structures they can explore.

Ångstrom’s machine learning model, CSP-MACE-Å, is 10,000 times faster than DFT. Calculations go from taking weeks with DFT to minutes with CSP-MACE-Å. This saves scientists time and allows far more candidate crystal structures to be evaluated, providing greater confidence when derisking crystal forms.

CSP-MACE-Å was also shown to outperform Meta's UMA-OMC model across Ångstrom’s and AstraZeneca's evaluation suites. Meta's UMA-OMC was the previous state-of-the-art machine learning interatomic potential for CSP; however, its accuracy was inferior to gold-standard DFT. CSP-MACE-Å is the first model to achieve DFT-level accuracy for CSP, delivering a massive speed improvement without sacrificing accuracy.

## The agent-driven experiment loop

The bottleneck in developing CSP-MACE-Å was the speed at which Ångstrom could iterate on a loop common to many AI research organizations: form a hypothesis, choose computational experiments, launch GPU jobs, retrieve and analyze the results, and decide what to test next. At the same time, the team had to reduce GPU costs and manage hardware failures and software bugs.

Ångstrom researchers used agents to help execute that loop. Researchers decided what computational experiments to run, which batches of jobs to launch, what outputs to compare, and what plots and metrics would answer the current question. Agents handled the work between those decisions: launching batches of `anycloud` jobs, monitoring status, downloading results, and generating plots and summaries for the next research decision.

This used the same local `anycloud` CLI and cloud configuration the team used by hand. The researchers stayed focused on the experiment plan and interpretation while agents handled the fan-out and bookkeeping between decisions. However, the same fan-out that made the loop fast also made it dangerous: the wrong batch of GPU jobs could become thousands of dollars of real spend before anyone noticed.

## How anycloud kept the AI research experiment loop under control

> “anycloud gives me the confidence to really let my agents loose without stressing that they will burn through all our compute. These days they continue to work throughout night, autonomously managing my research experiments, while I sleep."
>
> - **Laurence Midgley**, Co-founder & CTO, Ångstrom AI

One feature Ångstrom particularly values is **spend controls scoped to the agent session**: anycloud tracks and limits spend for each Claude Code, Codex, Cursor, or Aider session. These controls gave researchers the confidence to let their agents manage experiments autonomously. The operating model was not "give the agent cloud access"; it was "let this session spend up to X today or Y per hour." That matters because a runaway agent could keep launching GPU work that could turn into thousands of dollars of wasted cloud spend.

anycloud let the team set two independent guardrails for each agent session: a throttle to cap live burn rate in dollars per hour, and a budget to cap total spend over a calendar window. Account-wide caps can sit alongside them to bound all human and agent activity. When any cap is hit, new jobs wait in the queue; running jobs keep going.

<SpendControlsCarousel />

Slack makes spend and blocked work visible without watching a terminal. After a one-time `anycloud notifications connect slack`, anycloud posts a digest for the prior UTC day with compute spend and VM usage, initial submissions and resubmissions, the outcomes of ended Jobs, and how many of those Jobs were preempted at least once during their run. If a budget or throttle starts blocking new jobs, anycloud posts a waiting-on-spend-cap alert, with at most one reminder every six hours while the block lasts. A daily budget block clears at the next daily reset; a throttle block clears when live spend falls back under the configured ceiling. Caps block only new jobs; already-running jobs keep running.

<SlackNotificationsCarousel />

## What this unlocked for Ångstrom

> "Our monthly compute spend is often more than 2x higher than our cash burn - so compute cost is a serious problem for us. anycloud has been critical for letting us use our credits across all major providers efficiently. We run our experiments almost exclusively on spot, which has significantly extended our compute runway. The bottleneck for an AI research company is the rate at which we iterate on the _run experiments -> analyse results -> plan next experiments_ loop - anycloud lets us orchestrate hundreds of experiments each day."
>
> - **Laurence Midgley**, Co-founder & CTO, Ångstrom AI

Two problems sit behind Laurence's quote: **cost** and **iteration speed**. Cloud credits give startups access to the cheapest GPU capacity they will ever use, but those credits are stranded across providers, each with its own quotas, regions, and spot pools. And the rate of research is capped by how fast you can run the next batch of experiments. anycloud schedules work across every connected account, selects the cheapest available capacity, and runs on spot without requiring the workload to care which cloud it lands on. At Ångstrom, agents drove the research loop by calling the `anycloud` CLI directly against the team's own clouds.

The result: agents accelerated Ångstrom's experiment loop while anycloud provided the multi-cloud, spot, and spend-control layer underneath it.
