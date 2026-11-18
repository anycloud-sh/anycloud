# RFC 0028: Module-graph enforcement boundaries

> Status: Accepted
> Date: 2026-09-01
> Author: Claude draft
> Ratifies the enforcement architecture that landed earlier; the
> mechanisms shipped first and this document makes their invariants and
> threat model normative.

## Summary

Architectural module boundaries — directory ownership, module ownership, and
raw-database confinement — are enforced on the whole dependency graph by
dependency-cruiser (`yarn check:graph`), not per-file by ESLint. One companion
ESLint rule, `local/literal-module-loads`, guarantees the graph is complete:
dynamic loading does not exist in guarded scopes, the loader names themselves
cannot appear in any position, and module specifiers are restricted to the
shapes the graph extractor reliably records. The defense is flat prohibition
rather than usage analysis, and it stops at an explicit ceiling: literal-form
evasion is rejected mechanically; runtime construction of a loader or key is
review's responsibility.

## Context / problem

RFC 0025 made enforcement mechanisms citable; a graph-rules port replaced four
bespoke ESLint rules and their 200-line dynamic-load tracker with graph rules
and the flat companion guard. The port went through roughly eighteen adversarial
review rounds, and most of their cost was re-deriving scope questions — does
`eval` count, is `Reflect` in bounds, which specifier shapes are legal, where
mechanical defense ends — that had no ratified home. The answers lived in a
rule-header comment, one CONTRIBUTING paragraph, and a pull-request body:
durable prose, but not normative and not ledger-validated. By RFC 0025's own
principle that enforcement architecture is design, these invariants belong in
an RFC with an enforcement ledger. This document is mostly transcription; the
mechanisms and their tests already exist.

Two designs were tried and rejected on evidence before the current one. Usage
analysis — deciding which positions, aliases, keys, and call forms of a
loader are dangerous — regrew review findings for ten rounds, because every
analysis of an open syntax space has a position it mishandles. A reviewed
allowlist of dynamic-import sites was sound but carried label-fidelity
hazards in the extractor's edge dedupe; the port removed the need for it by
making the eight lazy-load sites static (`d64c93665`). What survived is the
design whose claims are checkable by grep: names that cannot appear, shapes
that cannot be written, and a graph that sees everything else.

## Proposal

Two layers, each doing what only it can:

- **The graph** (`.dependency-cruiser.cjs`, run by `yarn check:graph` inside
  `yarn check:boundaries`) holds every rule that needs whole-graph knowledge:
  directory boundaries, per-module ownership, raw-database confinement,
  unresolved-specifier rejection, and the known-roots fence. Graph rules have
  no inline disable; RFC 0025 ranks them with lint and boundary scripts.
- **The lint guard** (`local/literal-module-loads`, protected, wired for
  every extension the graph cruises) makes the graph complete by flat
  prohibition. It analyzes no usage: banned names cannot appear in any
  position, banned strings cannot appear as literals, and specifiers must be
  one of three shapes. The eval family is closed by core rules and by the
  name bans; `TSImportType` expressions are rejected because the extractor
  collapses them with runtime imports of the same module.

The threat model is part of the design. Mechanical defense covers accidents
and literal-form evasion — any load whose loader name or module specifier
appears literally (identifier, string, or substitution-free template) at the
point of use. Runtime construction — computed keys from variables,
concatenated strings, `globalThis.module` in CommonJS, `worker_threads`,
`vm`, `child_process` — is above the ceiling and belongs to review, per
CONTRIBUTING's standing doctrine that these checks constrain reviewed source
and are not a sandbox. A hostile committer edits the configuration; every
mechanical defense bottoms out at review of the configuration itself.

## Required invariants

1. Production source and repository scripts load modules only through static
   declarations; dynamic `import()` does not exist in guarded scopes.
   _Enforcement: lint:literal-module-loads — every `ImportExpression` is
   rejected; the eight former lazy-load sites became static imports in the
   same change; landed in the port._
2. The loader names `require`, `module`, and `getBuiltinModule`, and the
   loader-equivalent callables `eval` and `Function`, cannot appear in
   guarded scopes in any position — reference, binding, property, key,
   label, import name, or exact string — with `Function` legal as a type
   annotation and `module` legal as a string.
   _Enforcement: lint:literal-module-loads — flat name and string bans with
   no position analysis; the core lint:no-eval family and
   lint:no-new-func back the direct spellings; landed in the port._
3. TypeScript's non-identifier loader spellings are banned like the names:
   `import X = require(...)` and type-position `import('...')` expressions
   are rejected.
   _Enforcement: lint:literal-module-loads — `TSImportEqualsDeclaration` and
   `TSImportType` are unconditional errors; landed in the port._
4. A module specifier is a relative path, a bare package name, or a `node:`
   built-in; URL schemes, absolute paths, and `#` subpath aliases are
   rejected in value and type positions alike.
   _Enforcement: lint:literal-module-loads — specifier shapes are
   allowlisted, not denylisted; landed in the port._
5. Production source imports only what its shipped artifacts carry: `src/`,
   packages and `package.json`. Repository tooling, harnesses,
   experiments, benchmarks, workspace-only code and docs are out of bounds.
   _Enforcement: graph:production-source-boundary — resolved non-core
   targets only, as an allowlist; landed in the port, narrowed later._
6. Repository scripts do not load test or experiment code.
   _Enforcement: graph:script-boundary — same resolved-target semantics;
   landed in the port._
7. Value-level access to the raw database module is confined to the
   repositories layer and its named owners; erased type imports are exempt.
   _Enforcement: graph:raw-db-access — `tsPreCompilationDeps: 'specify'`
   labels erased edges `pre-compilation-only`, which separates pure type
   imports from runtime-emitting mixed statements; landed in the port._
8. Implementation-owned modules are imported only by their configured
   owners, and ownership rule names cannot silently collide.
   _Enforcement: graph:module-ownership:credential-bootstrap.azure-transport.ts —
   one generated rule per owned module with a load-time name-collision guard;
   entries an RFC cites are written with literal names, as this one and
   graph:module-ownership:credential-bootstrap.azure-cli-runner.ts are;
   landed in the port, with a later fix._
9. An unresolved specifier that is not a bare package name — a relative or
   absolute path, or any URL scheme — is itself a violation, so no local
   target escapes the boundaries by failing resolution.
   _Enforcement: graph:unresolvable-local-import — also the repository's
   only static check that import paths resolve, since tsc under bundler
   resolution is silent on unresolvable specifiers; landed in the port._
10. Every resolved local dependency lies under a known repository root, so a
    module outside the expected directories cannot launder a boundary hop.
    _Enforcement: graph:unexpected-root — discriminates on the resolver's
    `local` and `undetermined` classifications with `package.json` as the
    one named root-level exception; landed in the port._
11. The lint guard admits exactly the forms the graph extractor records, so
    nothing lint accepts is invisible to the graph.
    _Enforcement: test — the extractor-contract cases in
    `test/unit/eslint-plugin/local-plugin.spec.mjs` cruise one fixture per
    admitted form and assert edge presence, erased-import labeling, and the
    wrapped-form canary, so a dependency-cruiser upgrade that changes
    extraction semantics fails there instead of opening a silent hole;
    tracked and closed separately._
12. Mechanical defense ends at the literal-form ceiling; runtime-constructed
    loader access is rejected in review, not by these rules.
    _Enforcement: review — the residual list in the rule header names the
    accepted above-ceiling vectors, and findings above the ceiling become
    residual-list entries rather than code._

**10 of 12 verified wired, 1 cited, and 1 resting on review**: invariant 12.

## Residual surface

Named in `eslint-plugin-local/index.mjs` beside the rule and accepted as
review territory: fully computed property keys (`process[expr]`),
computed-string `Reflect` access, `globalThis.module` in CommonJS scripts,
and out-of-process load vectors (`worker_threads`, `vm`, `child_process`).
The gateway cloud-resource boundary is ledgered where it originated, as
RFC 0015 invariant 13.

## Alternatives considered

- **Per-position usage analysis** (which aliases, keys, and call forms of a
  loader are dangerous): rejected on ten rounds of evidence — an analysis of
  an open syntax space always has one more position, and its correctness is
  adversarially searchable rather than grep-verifiable.
- **A reviewed allowlist of literal dynamic imports**: shipped briefly,
  superseded when the eight lazy-load sites became static; the allowlist,
  its flushness token check, and its elision-collapse countermeasures were
  deleted rather than defended.
- **Keeping the 200-line dynamic-load tracker**: its alias chase was deeper
  than any single review round but shallower than all of them together; its
  threat catalog survives as regression tests, and banning names outright is
  strictly stronger than chasing their aliases.
