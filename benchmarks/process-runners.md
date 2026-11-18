# Process runner refactor probe

Run `yarn -s tsx benchmarks/process-runners.ts` with Node 22.18+ after
`yarn install --frozen-lockfile`. The probe prints JSON and uses local Node
subprocesses; no cloud credentials or services are needed. For comparison,
copy the same probe into a checkout of baseline commit `21be6b254`, install
its frozen lockfile, and run both checkouts sequentially with the same Node
version and no concurrent verification workload.

The probe measures the shell and E2E runners, which the cloud CLI deadline
cleanup does not change. These samples were collected after the capture and
cancellation fixes, using Node **22.23.2**, macOS arm64, on the same Mac. Both
runs were sequential with verification idle. The host was busy: its one-minute
load average was **29.23 on 10 logical CPUs** between runs and **27.81** afterward.
Timing differences under this contention do not isolate the effect of the refactor.

Each case runs in a fresh runner process, with three warmups and 20 measured
iterations. Median is the mean of the two middle samples; p95 uses the
nearest rank. Durations include subprocess launch and output drainage,
except managed stop, which starts timing after readiness. Deadline and
caller cancellation each trigger after 100 ms. Peak RSS is the high-water
mark of the runner process, including imports and warmups, excluding its
subprocesses. These are local observations, without a numerical acceptance
gate or a claim of statistical significance.

| Case                                    | Median ms, baseline → Execa | p95 ms, baseline → Execa | Peak RSS MiB, baseline → Execa |
| --------------------------------------- | --------------------------- | ------------------------ | ------------------------------ |
| Quiet E2E command                       | 61.409 → 70.891             | 84.021 → 169.762         | 85.344 → 89.531                |
| Captured shell command                  | 79.945 → 78.890             | 103.816 → 115.360        | 84.531 → 97.250                |
| 16 MiB stdout, retaining its 4 MiB tail | 3,288.450 → 2,615.552       | 5,268.713 → 3,736.656    | 350.047 → 448.047              |
| Deadline                                | 105.851 → 104.815           | 111.790 → 109.283        | 83.453 → 95.984                |
| Caller cancellation                     | 104.115 → 104.956           | 110.790 → 110.465        | 84.359 → 96.406                |
| Managed service stop                    | 3.403 → 4.078               | 14.490 → 11.243          | 85.062 → 97.594                |

Large-output throughput was **4.866 → 6.117 MiB/s**. Single-process startup
samples across the cases were 271–528 ms before and 416–989 ms after,
including imports. Managed-stop total process wall time fell from
**7,468.246 to 2,179.993 ms**: the baseline leaves its five-second
shutdown timer pending even after graceful exit. Output-heavy peak memory
depends on garbage collection and the existing rolling-tail allocations;
this probe does not establish a general memory improvement.

Full-file line counts include comments and blank lines. The original
**3,433-line** scope is now **3,918 lines**. The aggregate below also counts
the existing PTY suite on both sides, plus the new fixture and probe.

| Category                |    Before |     After |   Change |
| ----------------------- | --------: | --------: | -------: |
| Six runner modules      |     1,012 |       991 |      −21 |
| Six direct test suites  |     2,421 |     2,927 |     +506 |
| Existing PTY test suite |       386 |       413 |      +27 |
| Added CLI test fixture  |         0 |       138 |     +138 |
| Added benchmark code    |         0 |       155 |     +155 |
| **All code**            | **3,819** | **4,624** | **+805** |

Runner code shrank **2.1%**. Execa owns process completion and E2E escalation.
The captured runners retain local overflow and deadline pipe cleanup, and
Azure races caller cancellation with completion so a child ignoring SIGTERM
cannot delay the error. Latin1 capture supports Bun while preserving byte limits
and UTF-8 decoding. Custom code still owns rolling output tails, readiness validation,
process ownership, credential-environment construction, error adaptation,
redaction, and diagnostic artifacts.

`yarn verify` passed **422 test files and 10,330 tests**. The nine overflow and
cancellation regression cases fail against the original Execa refactor
(`32f7231e8`) and pass with these fixes. Six inherited-pipe deadline cases fail
against `496dde15b` and pass after closing capture pipes at the deadline.
Tests enforce prompt settlement and clean up owned processes in `finally`.
Coverage includes independent byte limits, exact output, environment isolation,
redaction, descendant cleanup, readiness, restart, and retry policy.

`yarn test:installed-wizard` passed **47 tests**, building and installing the
macOS ARM64 binary before exercising the common, AWS, Azure, GCP, and installed
CLI contracts with local provider fixtures. The suite also runs its Node PTY
check for inherited terminals and Ctrl+C. Raw-byte decoding, both byte caps,
overflow cleanup, and Azure cancellation also passed under Bun **1.3.3** and
a compiled Bun probe.
The six inherited-pipe deadline cases also passed in a compiled Bun **1.3.3**
probe at the production 30- and 60-second deadlines. Each runner returned after
one SIGTERM and the direct child's exit, with its helper still alive; timeout
classification was preserved. Node and Bun source probes matched the native
baseline's three-second Azure deadline.
Windows shell and terminal options are covered by unit assertions.
The measurement report itself is documentation, separate from code totals.
