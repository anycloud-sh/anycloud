# Ctrl-C diagnosis

- Status: Investigation complete; capture retained for the unreproduced terminal failure.
- Decision record: [Spike report](../../.context/ctrl-c-diagnosis/report.md)
- Run: `node --import tsx experiments/ctrl-c-diagnosis/run.ts`

Temporary diagnostic spike for the watched-command interrupt PR. The approved
plan is `.context/plans/diagnose-watch-ctrl-c.md`; results and disposable builds
belong in `.context/ctrl-c-diagnosis/`.

Start with normal terminal settings and uninstrumented binaries. Traced builds
observe existing handlers without starting another stdin reader or registering
an extra SIGINT handler. Forced raw mode is a control, not a reproduction of the
reported incident.

The local fixture reuses the repository's workload seeding helper and actual
API app for status and picker requests. Log bytes and delayed responses are
controlled locally so cancellation can be examined without cloud workloads.

These files do not implement or ship a product fix.

Run this from the affected terminal in this workspace. The default reproduces
the installed CLI's **Select view** picker against a seeded local API:

```sh
sh experiments/ctrl-c-diagnosis/capture.sh installed list-picker
```

Press Ctrl-C at the picker and run `echo $?` immediately after returning to the
shell. A picker cancellation currently exits 0. To investigate the watch after
selecting a workload, use `status-picker` instead; choose the workload,
wait for the first status display, then press Ctrl-C. A watch cancellation
should exit 130. Other cases are `status-id` and `logs-id`.

The command prints its capture directory and an external SIGINT command. If the
keypress fails, record when it was pressed and leave the CLI running. Use the
printed command from a second terminal to check whether SIGINT still works.
Repeat the keypress and external-signal cases in fresh runs before assigning a
cause. Running the same command in Apple Terminal provides a terminal-host
comparison. These captures use the local fixture; they cannot qualify a failure
that depends on a different API target.

For internal traces, use a disposable pre-change or candidate build:

```sh
sh experiments/ctrl-c-diagnosis/capture.sh base-bun status-picker --traced
sh experiments/ctrl-c-diagnosis/capture.sh candidate-bun status-picker --traced
```

Use `base-node` or `candidate-node` to compare the Node runtime. Traces can affect
timing, so preserve an uninstrumented failing capture first. The trace observes
existing callbacks and emitted input; absence of an ETX event does not prove
that no byte reached a paused or unread stream. Bun signal dispatch bypasses
the overridden `process.emit`, so use `sigint.handler` to establish receipt.

The shell launcher uses `exec` to retain the CLI's foreground process group and
inherited terminal descriptors. The separate observer queries `ps`, `stty`, and
`lsof`; it never reads terminal input or changes terminal modes. It records
process identity, terminal flags, descriptors, API requests, and unchanged
workload state. Traced builds add lifecycle/await checkpoints and an
unreferenced resource heartbeat. No keyboard bytes beyond control-event counts,
API credentials, or full request bodies are recorded.

Capture output is under `.context/ctrl-c-diagnosis/capture-*`. The observer and
fixture stop after CLI exit, after one minute without a CLI start, or after ten
minutes total. The ten-minute limit closes the fixture and is explicitly marked
in `complete.json`; resulting network errors are not natural CLI failures. The
observer cannot read another process's exit code: record it in the launching
shell. It never kills the CLI automatically.

The artifacts are already prepared in this workspace. To recreate them on this
macOS arm64 workspace with its installed Node and Bun dependencies:

```sh
yarn build
node experiments/ctrl-c-diagnosis/prepare.mjs
node experiments/ctrl-c-diagnosis/prepare-traced.mjs
node --import tsx experiments/ctrl-c-diagnosis/run.ts --label baseline-fresh
```

Each runner invocation creates `.context/ctrl-c-diagnosis/<label>-<suffix>/`
and prints `Results: <path>` to stderr. Labels can be reused for sequential or
concurrent runs; earlier artifacts are preserved.

The preparer pins the pre-change interrupt helper, the current revision,
toolchain, lockfile, and compiled binary hashes. It stops if the production diff
changes beyond the interrupt helper; reassess the comparison then. The installed
binary remains untouched. Neither the preparation nor the capture registers a
new production CLI command or flag.

## Promotion criteria

Promote only a failure observed in the affected environment, reduced to a
minimal regression case and a fix in the component that owns the behavior.
Place regression coverage in `test/` with that fix.

## Deletion criteria

Remove this capture bundle when the original environment has been qualified and
the resulting decision or minimal regression test is preserved. Desktop UI
automation was already deleted because focus changes invalidated those trials.
