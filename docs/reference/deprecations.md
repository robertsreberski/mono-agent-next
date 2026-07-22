---
title: "Deprecations & compatibility decisions"
description: "Track scheduled removals and intentionally permanent compatibility behavior across mono-agent releases."
sidebar:
  order: 8
---

This page is the canonical removal tracker for deprecated mono-agent surfaces.
Every scheduled removal names the first version where the old spelling stops
working. Compatibility paths retained indefinitely are recorded here too, so a
future cleanup does not mistake deliberate upgrade handling for dead code.

Recording a target here does not cut or publish that release. When a target
release is prepared, its removal PR must delete the implementation, tests, and
documentation together, then remove the completed row from this table.

## Scheduled removals

No deprecated surface currently has a scheduled removal.

## Removed surfaces

These surfaces were removed outright as part of pre-1.0 curation. CLI spellings
that still have a useful replacement fail with an explicit pointer; package and
programmatic surfaces are simply no longer exported.

| Removed surface | Replacement |
| --- | --- |
| `mono-agent restart --force` | `mono-agent restart --clear-sessions` (same effect) |
| `mono-agent metrics` | `mono-agent runs` (equivalently `mono-agent runs report`) |
| `mono-agent audit-runs` and its `--artifact-dir` flag | `mono-agent runs audit --artifacts <path>` |
| `mono-agent recipes list \| show <id>` | `mono-agent presets list \| show <id>` |
| `mono-agent init --recipe <id>` and `mono-agent validate --recipe <id>` | `--preset <id>` |
| `mono-agent sessions` (Session Recorder launcher) | `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console) |
| `@mono-agent/session-web`, `live.*` config/env, and the read-only live-event relay APIs | `mono-agent tui` for recorded-run replay or `mono-agent web` for live conversations |
| CLI flag `--fallback-models <csv>` | Repeat `--fallback <ref>` and, when needed, `--fallback-effort <level>` |
| `memory-bujo` standalone CLI bin | `mono-agent memory <subcommand>` from the agent folder |
| Runtime compatibility exports `./ai/backend.js`, `./ai/registry.js`, `findProviderForModel`, `listProviders`, and backend capability/provider constants | `resolveRuntimeBridge` and `listRuntimeBridges` |
| Memory helpers `reflect`, `ReflectDeps`, `ReflectResult`, and no-op `applyDecay` | Supported capture, consolidate, reconcile, and store APIs |

The three run/lifecycle compatibility spellings were removed in v0.14.0 after
their scheduled sunset. `--force` on `install-skill` and `web reset` is a
separate, non-deprecated flag.

The Session Recorder package, its read-only event relay, and the `live.*`
configuration/env surface were removed together after repository-wide
reachability checks found no supported caller. Unknown `live` config now fails
strict validation instead of being ignored. `MONO_AGENT_WEB_AUTH_TOKEN` is no
longer read by any code; its only reader was the removed `sessions` command.

The `--fallback-models` removal covers only the CLI CSV flag. Existing JSON
`runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain supported
compatibility inputs; those config forms are unaffected. The retired
recipe → preset mapping is recorded as static documentation in
[Presets & capability modules](/reference/presets/#deprecations). The
`memory-bujo` bin entry and its error-deflector were removed; use
`mono-agent memory <subcommand>` instead.

## Permanent compatibility

| Compatibility path | Decision and rationale |
| --- | --- |
| `LEGACY_TOOL_ALIASES` snake_case names in `tools.allowedTools` / `tools.disallowedTools` | **Retain indefinitely.** Existing hand-written policy lists cannot be migrated automatically. Removing an alias could deny a tool an old allow-list intended to enable or, more seriously, stop an old deny-list entry from matching the canonical tool and broaden access. New configs emit only PascalCase names; the aliases are accepted as input but are never registered, emitted, or recommended. |
| Managed-SRT schema-v1 install-lock reader | **Retain indefinitely.** `v0.9.0` and later write the v2 directory owner record with process incarnation identity, but a user may skip releases and encounter an owner-only v1 file left by a crashed v0.8-or-earlier installer. The legacy reader is bounded and fail-closed; new writes never use it. |
| Lifecycle-lock owner record without process incarnation | **Retain indefinitely.** `v0.9.0` and later write incarnation identity. A skipped-version upgrade can still encounter older crash debris, so the conservative PID-only liveness fallback remains as a permanent reader while every new record takes the stronger path. |

These readers and aliases are compatibility decisions, not pending removals.
Their code comments repeat the provenance and permanent-retention rationale at
the branch or map that handles the old input.
