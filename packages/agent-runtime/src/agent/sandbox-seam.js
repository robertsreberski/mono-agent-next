// Injectable sandbox seam.
//
// agent-runtime is a provider-agnostic kernel. This module removes its last
// workspace dependency by turning "how commands get sandboxed" into data a
// host hands the kernel, not code the kernel imports. A host constructs a
// `RuntimeSandbox` implementation and passes it to `createRuntime({sandbox})`
// (see runtime.js); every internal tool helper that used to import the sandbox
// implementation directly (bash.js, pi-bridge.js's MCP-stdio launcher,
// web-fetch.js, web-search.js,
// tool-context.js's policy merge) now reads `ctx.sandbox` and calls through
// this interface instead.
//
// `passthroughSandbox` is the zero-dependency default every ToolContext gets
// when no host supplies one (createToolContext/resetToolContext in
// ./tools/shared/tool-context.js). Its contract covers both no-injected-sandbox
// paths equally:
//   - No policy at all (both sides of a merge undefined, or a resolved policy
//     that is undefined): every operation is allowed, byte-identical to
//     running with no sandbox implementation installed at all.
//   - A policy IS present and its `mode` demands real enforcement ("native")
//     but nothing was injected to actually enforce it: FAIL CLOSED. This is a
//     deliberate behavior change from before this seam existed (where the
//     real sandbox implementation was bundled in agent-runtime and always did
//     the enforcing) — a host that configures a policy without wiring a real
//     RuntimeSandbox implementation used to get silent, unenforced
//     "enforcement"; now it gets a loud, actionable error instead. See
//     MIGRATION.md.
//   - `mergePolicies` still keeps I13's monotonic guarantee (a request-scoped
//     policy can only tighten, never weaken, the host-configured one) for the
//     two axes the passthrough itself inspects (`mode`, `network.mode`). It
//     is deliberately SHALLOW — no readable/writableRoots intersection, no
//     denyWrite union — the real, byte-identical merge algorithm is owned by
//     @mono-agent/runtime-adapter in packages/runtime-adapter/src/sandbox.ts
//     (`mergeSandboxPolicies`) and is wired in by every mono-agent host through
//     runtime-adapter.
//
// Real hosts (mono-agent, via @mono-agent/runtime-adapter) inject
// `{mergePolicies: mergeSandboxPolicies, prepareCommand: prepareSandboxedCommand,
// networkAllowsUrl: networkPolicyAllowsUrl}` from packages/runtime-adapter/src/sandbox.ts.
// Those exports already conform to this interface exactly, so the injection is a direct pass-through (see runtime-adapter's
// sandbox-impl.ts for the thin TS-side adapter that satisfies the seam's
// type shape).

// @ts-check

/**
 * @typedef {Object} SandboxCommandSpec
 * @property {string} command
 * @property {ReadonlyArray<string>} [args]
 * @property {string} [cwd]
 * @property {Object<string, string|undefined>} [env]
 * @property {boolean} [allowLocalBinding] Trusted per-command capability.
 */

/**
 * @typedef {SandboxCommandSpec & {sandboxed: boolean, cleanup?: () => Promise<void>}} PreparedSandboxCommand
 */

/**
 * @typedef {Object} SandboxNetworkPolicyLike
 * @property {string} [mode]
 * @property {ReadonlyArray<string>} [allowlist]
 */

/**
 * @typedef {Object} SandboxPolicy
 * Opaque, host-defined sandbox policy. The kernel itself only ever inspects
 * `mode` (passthroughSandbox's fail-closed check) and `network.mode`
 * (passthroughSandbox's networkAllowsUrl) — every other field (root,
 * readableRoots, writableRoots, denyWrite, ...) is read directly off whatever
 * the injected `mergePolicies` returns by path-resolver.js, and is opaque
 * pass-through data as far as this module is concerned. Real hosts get the
 * full, richly-typed policy from @mono-agent/runtime-adapter
 * (`packages/runtime-adapter/src/sandbox.ts`), whose `SandboxPolicy` is a
 * structural superset of this shape.
 * @property {string} [mode]
 * @property {SandboxNetworkPolicyLike} [network]
 * @property {ReadonlyArray<string>} [readableRoots]
 * @property {ReadonlyArray<string>} [writableRoots]
 * @property {ReadonlyArray<string>} [denyWrite]
 * @property {string} [root]
 */

/**
 * @typedef {Object} RuntimeSandboxEngine
 * Optional concrete sandboxing backend a caller can hand to `prepareCommand`
 * (matches @mono-agent/runtime-adapter's `SandboxEngine`). Not used by
 * `passthroughSandbox` (see module doc: adapters live in runtime-adapter, not
 * the kernel) — documented here only because it is part of the
 * `prepareCommand` input shape real implementations accept.
 * @property {() => Promise<boolean>} isAvailable
 * @property {(command: SandboxCommandSpec, policy: SandboxPolicy) => Promise<PreparedSandboxCommand>} prepareCommand
 */

/**
 * @typedef {Object} PrepareSandboxedCommandInput
 * @property {SandboxPolicy} [policy]
 * @property {RuntimeSandboxEngine} [engine]
 * @property {SandboxCommandSpec} command
 */

/**
 * @typedef {Object} RuntimeSandbox
 * The injectable sandbox seam. A host constructs one (or reuses
 * `passthroughSandbox`) and passes it to `createRuntime({sandbox})`.
 * @property {(configured: (SandboxPolicy|undefined), request: (SandboxPolicy|undefined)) => (SandboxPolicy|undefined)} mergePolicies
 *   Monotonic tighten-only merge (I13): the result must never allow anything
 *   `configured` alone would have denied.
 * @property {(input: PrepareSandboxedCommandInput) => Promise<PreparedSandboxCommand>} prepareCommand
 *   Resolves a command spec into whatever the underlying process spawner
 *   should actually exec (identity when no enforcement is needed).
 * @property {(policy: (SandboxPolicy|undefined), url: string) => boolean} networkAllowsUrl
 *   Whether a tool call to `url` is allowed under `policy`.
 * @property {ReadonlyArray<string>} [additionalReadPaths]
 *   Optional host-provided extra read-allowed roots beyond the tool
 *   context's workspace/repoRoot. Not consumed by any kernel helper today;
 *   documented for forward-compatibility with host-side path resolution.
 */

const SANDBOX_UNAVAILABLE_CODE = "sandbox_unavailable";

/**
 * Plain Error with a `.code`/`.details` shape matching the workspace's
 * CodedError convention (code discriminant + details that echo it, see the
 * agent-contracts package's CodedError) — duplicated here rather than
 * imported, since the kernel must not depend on any workspace package.
 */
class SandboxUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "SandboxUnavailableError";
    this.code = SANDBOX_UNAVAILABLE_CODE;
    this.details = { ...details, code: SANDBOX_UNAVAILABLE_CODE };
  }
}

/**
 * @param {string|undefined} mode
 * @returns {boolean}
 */
function isRealSandboxMode(mode) {
  return typeof mode === "string" && mode !== "off";
}

/**
 * @param {SandboxNetworkPolicyLike|undefined} configured
 * @param {SandboxNetworkPolicyLike|undefined} request
 * @returns {SandboxNetworkPolicyLike|undefined}
 */
function mergeNetwork(configured, request) {
  if (configured === undefined) return request;
  if (request === undefined) return configured;
  // The passthrough only distinguishes "all" (unrestricted) from everything
  // else (restricted); whichever side is NOT "all" tightens the result.
  if (configured.mode === "all" && request.mode === "all") return { mode: "all" };
  return configured.mode === "all" ? request : configured;
}

/**
 * @param {SandboxPolicy|undefined} configured
 * @param {SandboxPolicy|undefined} request
 * @returns {SandboxPolicy|undefined}
 */
function mergePolicies(configured, request) {
  if (configured === undefined) return request;
  if (request === undefined) return configured;
  // Only two modes exist today ("native" | "off"); "native" tightens over
  // "off" regardless of which side introduced it.
  const configuredIsReal = isRealSandboxMode(configured.mode);
  const requestIsReal = isRealSandboxMode(request.mode);
  const mode = configuredIsReal ? configured.mode : (requestIsReal ? request.mode : (request.mode ?? configured.mode));
  return {
    ...configured,
    ...request,
    mode,
    network: mergeNetwork(configured.network, request.network),
  };
}

/**
 * Identity command preparation — no sandboxing infrastructure of its own.
 * Fails closed the moment a policy actually demands enforcement, rather than
 * silently returning an unsandboxed command under a policy that looks
 * enforced.
 * @param {PrepareSandboxedCommandInput} input
 * @returns {Promise<PreparedSandboxCommand>}
 */
async function prepareCommand({ policy, command }) {
  if (policy === undefined || !isRealSandboxMode(policy.mode)) {
    return { ...command, args: command.args ?? [], cwd: command.cwd ?? process.cwd(), sandboxed: false };
  }
  throw new SandboxUnavailableError(
    "Sandbox policy requires enforcement (mode !== \"off\") but no RuntimeSandbox implementation is configured. "
      + "Inject a real implementation via createRuntime({sandbox}) (mono-agent hosts get this automatically through "
      + "the runtime-adapter package) or relax the policy.",
    { mode: policy.mode, command: command.command },
  );
}

/**
 * @param {SandboxPolicy|undefined} policy
 * @param {string} _url
 * @returns {boolean}
 */
function networkAllowsUrl(policy, _url) {
  if (policy === undefined) return true;
  // A policy whose mode demands real enforcement must fail closed on network
  // access too when no `network` sub-field was given — an absent `network`
  // is not "all", and this is the passthrough's safety net for hand-built
  // policies from hosts with no real RuntimeSandbox wired in (see module
  // doc's fail-closed rationale, and prepareCommand above for the analogous
  // command-side check this mirrors via isRealSandboxMode).
  if (isRealSandboxMode(policy.mode)) return policy.network?.mode === "all";
  return policy.network === undefined || policy.network.mode === "all";
}

/** @type {RuntimeSandbox} */
export const passthroughSandbox = {
  mergePolicies,
  prepareCommand,
  networkAllowsUrl,
};

export { SandboxUnavailableError, SANDBOX_UNAVAILABLE_CODE };
