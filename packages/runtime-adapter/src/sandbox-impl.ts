import { mergeSandboxPolicies, networkPolicyAllowsUrl, prepareSandboxedCommand } from "./sandbox.js";

/**
 * The real sandbox implementation, wired into every runtime this façade
 * creates (see `createMonoRuntime` in runtime-adapter.ts). agent-runtime's
 * kernel has no dependency on this package — it defines an
 * injectable `RuntimeSandbox` seam (`agent/sandbox-seam.js`) and ships only a
 * fail-closed `passthroughSandbox` default. This module is the ONE place a
 * mono-agent host's sandbox policy actually gets enforced: every
 * `createMonoRuntime(...)` call injects `monoSandboxImpl` so behavior stays
 * byte-identical to before this seam existed.
 *
 * The kernel's `RuntimeSandbox` methods are typed with an intentionally
 * opaque `SandboxPolicy` (it only inspects `mode`/`network.mode` itself); the
 * real runtime-adapter `SandboxPolicy` is a richer, structurally
 * compatible superset. Assigning the real functions directly as the kernel's
 * property types would fail TypeScript's (correct) contravariant parameter
 * check — the kernel's interface promises to call `mergePolicies` with any
 * opaque-shaped policy, which the real, stricter function doesn't accept.
 * These are thin adapters that cross that boundary.
 */
export const monoSandboxImpl = {
  mergePolicies(configured: any, request: any): any {
    return mergeSandboxPolicies(configured, request);
  },
  async prepareCommand(input: { policy?: any; engine?: any; command: any }): Promise<any> {
    return prepareSandboxedCommand(input);
  },
  networkAllowsUrl(policy: any, url: string): boolean {
    return networkPolicyAllowsUrl(policy, url);
  },
};
