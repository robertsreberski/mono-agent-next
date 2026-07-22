import { describe, expect, it } from "vitest";
import {
  createSandboxPolicy,
  failClosedSandboxPolicy,
  mergeSandboxPolicies,
  networkPolicyAllowsUrl,
  prepareSandboxedCommand,
} from "../sandbox.js";

import { monoSandboxImpl } from "../sandbox-impl.js";

// monoSandboxImpl is the thin adapter that satisfies agent-runtime's
// RuntimeSandbox seam (see agent/sandbox-seam.js) with the real
// runtime-adapter sandbox implementation. Its methods must behave byte-identically
// to calling the functions in packages/runtime-adapter/src/sandbox.ts directly — the adapter exists
// purely to cross a TypeScript structural-typing boundary (opaque kernel
// SandboxPolicy vs. the package's richer one), not to change behavior.
describe("monoSandboxImpl (real sandbox implementation injected into createMonoRuntime)", () => {
  it("mergePolicies delegates to mergeSandboxPolicies with the same monotonic result", () => {
    const configured = failClosedSandboxPolicy({ root: "/repo/workspace" });
    const request = failClosedSandboxPolicy({ root: "/repo/workspace/sub" });

    expect(monoSandboxImpl.mergePolicies(configured, request)).toEqual(mergeSandboxPolicies(configured, request));
    expect(monoSandboxImpl.mergePolicies(undefined, configured)).toEqual(mergeSandboxPolicies(undefined, configured));
    expect(monoSandboxImpl.mergePolicies(configured, undefined)).toEqual(mergeSandboxPolicies(configured, undefined));
  });

  it("prepareCommand delegates to prepareSandboxedCommand (identity when the policy is off/absent)", async () => {
    const command = { command: "/bin/echo", args: ["hi"], cwd: "/tmp" };

    const viaAdapter = await monoSandboxImpl.prepareCommand({ command });
    expect(viaAdapter).toMatchObject({ command: "/bin/echo", args: ["hi"], cwd: "/tmp", sandboxed: false });
  });

  it("prepareCommand fails closed under a native policy with no engine available, matching prepareSandboxedCommand directly", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/workspace" });
    const command = { command: "/bin/echo", args: [] };
    const engine = {
      id: "synthetic-unavailable-srt",
      async isAvailable() {
        return false;
      },
      async prepareCommand() {
        throw new Error("unavailable engine must not prepare commands");
      },
    };

    await expect(prepareSandboxedCommand({ policy, command, engine })).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    await expect(monoSandboxImpl.prepareCommand({ policy, command, engine })).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("prepareCommand preserves an explicit unsafe host-process fallback", async () => {
    const policy = createSandboxPolicy({
      root: "/repo/workspace",
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    const command = { command: "/bin/echo", args: ["hi"], cwd: "/repo/workspace" };
    const engine = {
      id: "fake",
      async isAvailable() {
        return false;
      },
      async prepareCommand() {
        throw new Error("should not prepare");
      },
    };

    const direct = await prepareSandboxedCommand({ policy, command, engine });
    await expect(monoSandboxImpl.prepareCommand({ policy, command, engine })).resolves.toEqual(direct);
    expect(direct).toMatchObject({ command: "/bin/echo", args: ["hi"], cwd: "/repo/workspace", sandboxed: false });
  });

  it("networkAllowsUrl delegates to networkPolicyAllowsUrl", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/workspace" });

    expect(monoSandboxImpl.networkAllowsUrl(policy, "https://example.com")).toBe(
      networkPolicyAllowsUrl(policy, "https://example.com"),
    );
    expect(monoSandboxImpl.networkAllowsUrl(undefined, "https://example.com")).toBe(true);
  });
});
