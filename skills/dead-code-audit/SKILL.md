---
name: dead-code-audit
description: Prove-or-remove protocol for dead exports, orphaned wiring, and deprecated surfaces across the whole monorepo. Use for pre-freeze cleanup, post-refactor sweeps, deciding whether a deprecated surface is removable, or when asking "is this dead code?".
---

# Dead code audit

Passing tests prove nothing about reachability. A symbol can have full unit
coverage and **zero live callers** — the CI gate (`verify-green`) is green on a
dead-but-well-tested path. Six auditors independently hit the same shape at
freeze time: good coverage, no caller, nothing systematically catching it. This
is the prove-or-remove discipline that does.

Scope every sweep to the **whole monorepo**, not the owning package, and exclude
tests — a symbol's own tests are not a live caller:

```bash
cd "$(git rev-parse --show-toplevel)"
# canonical monorepo source glob (extras/ are publishable plugin packages too):
grep -rln "<symbol>" packages/*/src extras/*/src --include="*.ts" | grep -v __tests__
```

## 1. Whole-monorepo dead-export grep

For each symbol a package's public `index.ts` exports, grep the *rest* of the
monorepo for a non-test caller:

```bash
grep -rln "<symbol>" packages/*/src extras/*/src --include="*.ts" | grep -v __tests__
```

Zero non-owning callers **and** no `@deprecated`/`@experimental` label ⇒ removal
candidate. Good test coverage is not a reprieve. (The dead public search API in
`memory` was found exactly this way.)

## 2. Maintenance-routine call-site check

When a diff adds an exported `compact*`/`prune*`/`rotate*`/`gc*` function, it
must have a non-test call site in the **runtime lifecycle** — a periodic
maintenance routine that is defined and tested but never wired is invisible to
the gate. The correct pattern already ships: `pruneTraceSources` is called from
`tui-command.ts` and `web-command.ts` at startup. `compactPostedMessageIndex`
shipped tested-but-never-wired.

```bash
git diff --name-only | xargs grep -l "^export.*function.*\(compact\|prune\|rotate\|gc\)"
grep -rl "<fnName>(" <package>/src | grep -v __tests__   # must return MORE than the definition file
```

If the only hit is the file that defines it, the routine never runs — wire it
into the lifecycle or remove it.

## 3. Orphaned wiring after a "shared / pooled / cached" refactor

Every time a refactor introduces a shared/pooled/cached version of an existing
per-request mechanism, grep for the **old** mechanism's exports in the same pass
and either remove or justify each. This shape recurs (runtime live-sessions
redesign, agent-runtime kernel redesign); dead `createMemoryRecallRuntimeExtension`
survived it.

```bash
git diff --name-only | grep -i "\(shared\|pool\|cache\)"   # spot the refactor
grep -rln "<old-per-request-symbol>" packages/*/src extras/*/src --include="*.ts" | grep -v __tests__
```

## 4. Duplicated-primitive sweep before hand-rolling

Before writing any non-trivial parser/algorithm/primitive, grep the monorepo —
especially packages already in this package's `package.json` deps — for an
existing implementation:

```bash
grep -rln "<primitive-name>" packages/*/src --include="*.ts" | grep -v __tests__
```

Real misses this would have caught:

- `memory-rituals.ts` hand-rolled a cron parser the repo already had.
- The mkdir / `owner.json` / incarnation / quarantine singleton-lock
  choreography was re-derived **four times** (worker lease, CLI lifecycle lock,
  managed-runtime install lock, SRT install lock) — all already share
  `process-incarnation.ts` as their liveness primitive; only the
  directory/rename dance was duplicated.

## 5. The 5-step deprecation-removability protocol

A shallow single grep produces wrong verdicts. Run **all five** before declaring
a deprecated surface "removable":

1. grep the symbol across all non-test app/cli source;
2. grep `demos/` and `scripts/`;
3. grep **both** live-instance directories **and every launchd plist**;
4. grep `docs/` — this distinguishes *documented-as-intentionally-retained
   legacy* from *accidentally-orphaned*;
5. if a CLI binary is involved, check `package.json`'s `bin` — a **published**
   contract raises the bar past "no current caller."

```bash
S=<symbol>
grep -rln "$S" packages/*/src extras/*/src --include="*.ts" | grep -v __tests__   # 1
grep -rln "$S" demos/ scripts/                                                     # 2
grep -rln "$S" ~/personal-agent ~/agents ~/personal ~/Library/LaunchAgents/com.mono-agent.*.plist  # 3
grep -rln "$S" docs/                                                               # 4
grep -n "\"bin\"" packages/*/package.json                                          # 5, if a CLI
```

**Case study — one-looking deprecations, two verdicts.** Running all five
against two BuJo memory deprecations produced *opposite* answers: the
`packages/memory/src/bujo/reflect.ts` function is documented/retained legacy ⇒
**keep**; the `packages/memory/src/bujo/store.ts` methods had no live caller,
no doc, no plist reference ⇒ **remove**. A shallower check would have lumped them
together and been wrong on at least one.

## 6. Prove live-usage from manifests, read-only

For content-addressed / manifest-based subsystems, "is this path exercised?" is
answerable with proof, not speculation: read the **live instance's**
manifest/runtime sidecars directly. Always `mode=ro` — **never write** to a live
instance's state:

```bash
# read-only — turns "is this used?" from speculative into proven-with-a-timestamp:
cat ~/personal-agent/.mono-agent/memory/.index/manifest.json
cat ~/personal-agent/.mono-agent/memory/.index/runtime.json
cat ~/personal-agent/.mono-agent/memory/.memory-forget-backup-*/manifest.json
```

A referenced hash / recent timestamp in the manifest proves the path is live;
its absence — after steps 1–5 also come up empty — is the removal proof.

## Verdict

Every "dead" call needs the command evidence behind it: which globs returned
zero, which steps of the 5-step protocol were run, which manifest was read.
`@deprecated`/`@experimental`-labelled and `bin`-published surfaces are **keep
unless a removal version is set** (that alias/sunset bookkeeping lives in
`release-lockstep`). Everything else with zero non-test callers across all six
checks is removable — say so, with the evidence.
