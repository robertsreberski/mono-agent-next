# `@mono-agent/agent-runtime` — Migration Guide

Breaking and behavioral changes for consumers upgrading from `0.3.x` to the
current pre-1.0 contract. `createRuntime()` remains the package entry point;
`createMonoRuntime()` remains the typed facade in
`@mono-agent/runtime-adapter`. Provider-session input/output uses
`providerSessionId`, with `disposeSession()` and `disposeAllSessions()` retained.

Review every section that matches your usage. The package now has an explicit
exports map, a five-bridge lazy registry, typed policy objects, stricter sandbox
behavior, and revised provider-session semantics even when Pi is not your
primary route.

---

## Pre-1.0 public-surface cleanup

The compatibility entrypoints `./ai/backend.js` and `./ai/registry.js` were
removed after repository-wide reachability checks found no supported caller.
The old `findProviderForModel` / `listProviders` aliases and provider/backend
constant objects were removed at the same time. Import `resolveRuntimeBridge`
or `listRuntimeBridges` from `@mono-agent/agent-runtime` (or its `./ai` barrel)
instead. Runtime behavior and the canonical bridge descriptors are unchanged.

---

## 1. Pi is now native-only (`pi-sdk.js` → `pi-native.js`)

The hand-rolled Pi bridge that drove the low-level `Agent` was replaced by a
bridge built on `@earendil-works/pi-agent-core`'s high-level `AgentHarness`. The
registry resolves `pi` → the native bridge unconditionally; there is no
`piEngine` flag.

- **Public runtime API** (`createRuntime`, model reference `"pi:<provider>:<model>"`)
  is unchanged — `pi:openai:gpt-5.5` etc. still work.
- **Deep imports** of `@mono-agent/agent-runtime/ai/providers/pi-sdk.js` **no
  longer resolve**: the compatibility shim was removed and the explicit exports
  map has no provider wildcard. **Action:** import
  `generatePiNativeResponse` / `piNativeRuntimeBridge` from
  `@mono-agent/agent-runtime/ai`, or select Pi through the public runtime
  registry. `pi-errors.js` is internal and is not an exported replacement; use
  the normalized `RuntimeResult.failureKind` or the public failure helpers at
  `@mono-agent/agent-runtime/ai/failure.js`. The `pi*Backend` aliases are gone —
  all Pi routes through the native bridge.

## 2. Removed run options: `piReasoningSummary`, `piCodexTransport`

These were Pi-bridge knobs the native path does not consume.

- `piReasoningSummary` is **no longer read** and was removed from the run-options
  type. Pi-native derives reasoning from `effort` (`thinkingLevel`); the
  Codex and Claude CLI bridges emit their own reasoning events. **Action:**
  remove `piReasoningSummary` from call sites. The former
  `runtime.reasoningSummary` config field has also been removed.
- `piCodexTransport` was doc-only and is removed. No replacement is needed.

## 3. Pi context compaction: bridge-driven via AgentHarness.compact()

`AgentHarness` has no automatic compaction, so the pi bridge drives it directly
(the legacy low-level `transformContext` / `afterToolCall` hooks and
`createAgentCompactionManager` were removed):

- Before each turn the bridge estimates the running model's context usage and
  calls `AgentHarness.compact()` when near the window (proactive). If a turn still
  overflows the bridge compacts once and re-prompts (reactive recovery).
- Runs report **`capabilitiesUsed.context_compaction_applied`** as `true` (a
  compaction fired), `false` (enabled but not needed), or `null` (disabled via
  `runtime.compaction.enabled: false`). If you assert on this value, expect this
  tristate on the Pi path.
- The host **`onCompactionRecorded`** callback now **fires on each automatic
  compaction** on the Pi path (previously inert).
- The trigger and omitted budgets adapt to the model actually serving the
  request (`harness.getModel()`). Numeric overflow limits and generic failed
  request estimates lower a learned process-local ceiling; use
  `runtime.compaction.contextWindowOverride` for a persistent metadata
  correction. Deprecated programmatic `agent_compaction_*` settings and
  `resolveAgentCompactionPolicy` remain compatibility surfaces.

## 4. Durable Pi session resume: create-on-miss semantics

When a run supplies a `providerSessionId` (or the legacy `sessionId` alias) **and**
durable storage is configured (`piSessionsRoot`), Pi-native now **creates the
session with that id if no on-disk JSONL exists** (create-on-miss), instead of returning
`session_not_found`. An existing JSONL is reopened and resumed as before.

This makes a **stable, conversation-derived session id resume across process
restarts** (the on-disk transcript is the durable history; the in-memory
conversation→session map is no longer required to resume). **Action:** if you
passed an arbitrary `providerSessionId` to a durable run expecting a hard
`session_not_found` on first use, note it now succeeds by creating that session.
The in-memory (non-durable) resume path still fast-fails `session_not_found` on a
miss.

## 5. Fallback router enforces requested native-subagent capability

Pi advertises `supports_native_subagents: false`. The fallback router now infers
a `supports_native_subagents` requirement when a run passes
`options.nativeSubagents.teammates` (non-empty), the same way it already infers
`structured_output` from `outputSchema`. A chain entry that cannot satisfy it
(e.g. a Pi fallback behind a Claude primary that was handed native teammates) is
**skipped** (`skipped_capability_mismatch`) rather than silently succeeding with
`nativeSubagentsUsed: []`. **Action:** if you configure fallback chains for
native-subagent runs, ensure at least one entry supports native subagents, or the
run reports exhausted instead of degrading silently.

## 6. Diagnostics & internal behavior changes (no API change)

- **Pi multimodal**: image inputs are delivered to the model as image content
  blocks (internal fix; affects behavior, not the call shape).
- **Tool-output limits**: settings-driven clamps (`agent_tool_text_limit_chars`,
  `agent_search_result_limit`, `toolPayloadMaxBytes`, …) are honored again on the
  Pi path (built-ins + MCP). The 256 KB tool-payload ceiling is unchanged.
- **WebFetch** retries transient network errors (timeout / ECONNRESET / 5xx)
  in-tool with backoff before returning an error.
- **Claude CLI**: the temporary `mcp.json` written for a CLI run is now created
  with `0600` (owner-only) permissions.
- Pi session lifecycle is hardened: aborts during setup are honored before the
  provider call, fresh durable sessions are deleted on setup/abort failure, and
  resumed sessions roll back to their pre-turn leaf on host-side (outer-catch)
  failures. These are correctness fixes with no API surface change.

## 7. Sandbox enforcement is now an injectable seam (agent-runtime has zero workspace-package dependencies)

`@mono-agent/agent-runtime` does not depend on `@mono-agent/runtime-adapter`. Sandbox
enforcement (command sandboxing, network-policy checks, and monotonic policy
merging) is now driven through an injectable `RuntimeSandbox` seam
(`agent/sandbox-seam.js`): `createRuntime({sandbox})` / `createRouterRuntime({host: {sandbox}})`
accept an implementation. `@mono-agent/runtime-adapter` injects the real
sandbox implementation automatically for every
`createMonoRuntime(...)` call, so behavior is **byte-identical** for existing
mono-agent hosts — no action needed if you build your runtime through
`@mono-agent/runtime-adapter`.

- **No sandbox policy configured, no implementation injected:** unchanged —
  every tool runs unsandboxed, exactly as before.
- **A sandbox policy IS configured, but no `RuntimeSandbox` implementation is
  injected** (only possible if you call `@mono-agent/agent-runtime`'s
  `createRuntime` directly, bypassing `@mono-agent/runtime-adapter`): **this
  now fails closed** with a `sandbox_unavailable` error instead of silently
  running the command unsandboxed. Previously `@mono-agent/agent-runtime`
  always bundled the real sandbox implementation and always enforced the policy; a
  host that built on `createRuntime` directly and relied on that implicit
  availability must now also inject a `RuntimeSandbox` implementation (the
  real one from `@mono-agent/runtime-adapter`, or a custom one) to keep policies
  enforced. **Action:** if you configure `sandboxPolicy` and call
  `createRuntime`/`createRouterRuntime` directly instead of going through
  `@mono-agent/runtime-adapter`, also pass a `sandbox` implementation, or drop
  the policy.

## 8. Typed run options replace the `settings` bag (`toolLimits` / `compaction` / `prompts`)

The flat `options.settings` bag is **deprecated** as the way to configure
tool-output clamps and context compaction. The supported replacements are typed,
per-run objects on `RuntimeRunOptions`:

- **`options.toolLimits`** (`RuntimeToolLimits`) — `toolTextLimitChars`,
  `bashOutputLimitChars`, `mcpTextLimitChars`, `searchResultLimit`,
  `imageInlineMaxBytes`, `toolPayloadMaxBytes`, `mcpCallTimeoutMs`,
  `mcpCallMaxTotalTimeoutMs`, `bashTimeoutMs`.
- **`options.compaction`** (`RuntimeCompactionPolicy`) — `enabled`,
  `triggerRatio`, `keepRecentTokens`, `summaryMaxTokens`, `minSavingsTokens`,
  `fixedOverheadEnabled`, `contextWindowOverride`.

Precedence is **per-group**: a present typed object wins wholesale for its group
and that group's legacy `settings` keys are ignored; an absent typed object lets
its group's `settings` keys through as a fallback. Consuming **any** legacy
`settings` key emits exactly one `runtime_warning` with
**`warning_kind: "deprecated_settings_option"`** per run (listing the consumed
keys). Passing no `settings` — or an empty/irrelevant bag — never warns.

`resolveAgentCompactionPolicy(settings, model)` stays exported (the canonical
clamp/mapper both paths route through), and `@mono-agent/runtime-adapter` exposes
`resolveRuntimePolicies(settings)` to map a legacy bag to the typed objects.
The migration helper preserves omitted legacy compaction values so adaptive
defaults are resolved later against the live model rather than frozen at the
mapper's fallback window.
**Action:** migrate `settings` → `toolLimits` / `compaction`; until then the shim
keeps working with one deprecation warning per run.

## 9. New per-run overrides: `sandbox`, `sandboxPolicy`, `prompts`

Beyond `toolLimits` / `compaction`, `RuntimeRunOptions` gained:

- **`sandbox`** — a per-run `RuntimeSandbox` implementation override. Precedence
  is run > host > passthrough; it overrides only the *enforcing code*, while the
  policy **data** still merges monotonically (I13, section 7).
- **`sandboxPolicy`** — per-run policy data, merged monotonically with the host
  policy (it can **tighten**, never weaken or disable).
- **`prompts`** (`RuntimePromptOverrides`) — per-run overrides of the kernel's
  built-in prompt fragments: `structuredOutputInstruction(systemPrompt)`,
  `structuredOutputFinalization()`, `liveInputGuidance(body)`. Run wins over the
  host-level `prompts` default; an absent field keeps the built-in string
  (byte-identical default). These are also accepted on `AgentRuntimeHostOptions`
  as the host-level default.

## 10. Pi 0.80 auth: `Models` credential store (`resolvePiApiKey` semantics preserved)

Pi 0.80 removed the harness `getApiKeyAndHeaders` hook; request auth now resolves
through a `Models` collection's `CredentialStore`. The bridge's **per-run
key-resolution contract is unchanged**: an `apiKeys` map entry wins, else the host
`resolvePiApiKey(provider)` callback is consulted; a callback failure emits a
`pi_auth_failed` runtime warning and proceeds keyless (a builtin provider then
falls back to its own env vars, exactly as returning `undefined` from the old hook
did). **No host action needed** — `resolvePiApiKey` behaves as before.

Dependency bump: **`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are
now `0.80.6`** (the initial Pi 0.80 migration landed at `0.80.5`, from
`^0.79.1`). Compaction is driven natively (section 3). The `0.80.6` refresh also
preserves model-native `max` reasoning and Pi's request-wide pricing tiers.

## 11. Exports map: wildcards removed (explicit deep-path map)

The package's `./ai/*` and `./agent/*` **wildcard exports were replaced by an
explicit `exports` map**: 3 barrels (`.`, `./ai`, `./agent`) plus the generated
deep-path inventory below, with every entry carrying its own `types` condition.
A deep import that is not on the map **no longer resolves** — a wildcard used to
silently resolve anything under `src/`, so a moved/renamed/mistyped subpath is
now a loud failure (guarded by `scripts/verify-deep-imports.mjs`).

<!-- public-api-js-subpaths:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

The package exposes **21 named deep `.js` subpaths**:

```text
@mono-agent/agent-runtime/agent/allowlists.js
@mono-agent/agent-runtime/agent/compaction.js
@mono-agent/agent-runtime/agent/prompt/skill-index.js
@mono-agent/agent-runtime/agent/tools/index.js
@mono-agent/agent-runtime/agent/tools/shared/ripgrep.js
@mono-agent/agent-runtime/agent/tools/shared/runtime-context.js
@mono-agent/agent-runtime/agent/transcript.js
@mono-agent/agent-runtime/ai/cost.js
@mono-agent/agent-runtime/ai/failure.js
@mono-agent/agent-runtime/ai/file-change-stats.js
@mono-agent/agent-runtime/ai/live-input-prompt.js
@mono-agent/agent-runtime/ai/providers/claude-cli.js
@mono-agent/agent-runtime/ai/providers/claude-sdk-discovery.js
@mono-agent/agent-runtime/ai/providers/claude-sdk.js
@mono-agent/agent-runtime/ai/providers/codex-app.js
@mono-agent/agent-runtime/ai/providers/opencode-discovery.js
@mono-agent/agent-runtime/ai/runtime/context-windows.js
@mono-agent/agent-runtime/ai/runtime/fast-mode.js
@mono-agent/agent-runtime/ai/runtime/model-refs.js
@mono-agent/agent-runtime/ai/runtime/registry.js
@mono-agent/agent-runtime/ai/streaming/codex-events.js
```
<!-- public-api-js-subpaths:end -->

**Action:** if you deep-import a subpath not in this list, switch to the closest
supported one, a barrel (`./ai` / `./agent`), or the public runtime registry.
`pi-sdk.js` is gone and remains intentionally unexported (section 1). Import
`generatePiNativeResponse` from `@mono-agent/agent-runtime/ai` instead of adding
a compatibility subpath.

---

## Version

This guide describes the published `0.13.x` package contract. Keep
`@mono-agent/agent-runtime`, `@mono-agent/runtime-adapter`, and other
`@mono-agent/*` packages on the same lockstep version when upgrading. The paired
runtime adapter no longer exposes `piReasoningSummary` in its run-options type.

---

## Appendix — Porting this kernel to a new scope/host (worklab port-readiness)

This kernel is designed to be vendored into a differently-scoped host (the
concrete target is **worklab**, `@worklab-ai/agent-runtime`, GPL-3.0-only, npm
workspaces, pure-JS no-build, consuming this package's raw `src/`). The port
itself is a follow-up; this is the executable checklist, with the port-readiness
dry-run results recorded inline (verified against the worklab tree read-only).

Run these before/at the port:

1. **Scope rename `@mono-agent/` → `@worklab-ai/`.** Touches `package.json`
   (`name` + the package-name prefix inside each `exports` key's consumer
   specifier) only — the kernel's own source uses **relative** imports, so no
   source import references the scope. *(Verified: zero `@mono-agent/*` specifiers
   in `src/`.)*
2. **Dependencies.** Post-decoupling the kernel has **zero workspace-package
   deps**; only the third-party pins need aligning: `@earendil-works/pi-ai` +
   `@earendil-works/pi-agent-core` (`0.80.6`), `@modelcontextprotocol/sdk`,
   `@opencode-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `zod`.
3. **Pi bump `^0.74.0` → `0.80.6` in lockstep.** worklab tests that use old pi
   APIs are rewritten at the port. Do not restore the old `pi-sdk.js` deep
   import; use `generatePiNativeResponse` from `@mono-agent/agent-runtime/ai`.
4. **Sandbox.** worklab passes **no** `sandbox` implementation → `passthroughSandbox`,
   and **never sets `sandboxPolicy`** *(verified: zero `sandboxPolicy` /
   `sandbox:` in worklab `src/`)*, so with no policy every tool runs unsandboxed
   exactly as today — behavior is byte-identical. (If worklab later adds a policy,
   it must also inject a `RuntimeSandbox` impl — section 7's fail-closed rule.)
5. **License / packaging.** GPL-3.0-only stays; `files` includes `types/`
   (additive — worklab consumes raw `src/`, `.d.ts` generation is optional).
6. **Deep imports resolve.** `node scripts/verify-deep-imports.mjs` (default +
   types conditions) is green. Every worklab **non-test** deep import resolves in
   the explicit exports map *(verified — no gap)*, and the Worklab-test provider
   bridge imports for `claude-sdk.js`, `claude-cli.js`, and `codex-app.js` are
   supported as exported subpaths. The only worklab deep import NOT in the map is
   the removed **test-only** `pi-sdk.js`; those tests are rewritten at the port
   (step 3), so no export entry is added for it.
7. **Contract supersets.** `HOST_KEYS` ⊇ worklab's host bag *(verified:
   worklab passes `resolveCustomPricing`, `onCompactionRecorded`, `persistArtifact`,
   `resolvePiApiKey`, `observers` — all covered)*; the deep-import
   `configureToolRuntime` accepts worklab's keys *(verified: `workspace`,
   `repoRoot`, `runId`, `toolArtifactDir`, `ripgrepPath`, `qaOutputDir` ⊂
   `TOOL_CONTEXT_KEYS`)*; and every `RuntimeResult` field worklab's
   `worker/agent-turn.js` reads exists on the result *(verified: `cancelled`,
   `providerSessionId`, `error`, `failureKind`, `errorDetails`, `diagnostics`,
   `runtimeWarnings`, plus `text`/`usage`/`model`/`effort`/`numTurns`/
   `structuredResult`/`capabilitiesUsed`/`durationMs`/`failoverHistory`;
   `observerSnapshot` is worklab-side, folded from its own metrics observer)*.
8. **`options.settings` day one.** Works via the deprecated shim (section 8) with
   one `deprecated_settings_option` warning per run; worklab later maps
   `settings` → the typed policy objects in its `core/ai.js`.
9. **Test layout + no-build consumption.** `src/__tests__` + vitest already match;
   the package is fully consumable from raw `src/` with **no build**
   *(verified: a smoke import of `createRuntime` / `createRouterRuntime` from
   `src/index.js` constructs a runtime with no model call)*.
