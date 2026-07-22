import { readdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../background-snapshot-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../background-snapshot-key.js")>();
  const key = Buffer.alloc(32, 0x43);
  return {
    ...actual,
    loadBackgroundSnapshotKey: async () => Buffer.from(key),
    loadOrCreateBackgroundSnapshotKey: async () => Buffer.from(key),
  };
});

import {
  CONFIGURATION_PROPOSAL_TOOL_NAME,
  createConfigurationProposalServer,
  type AgentConfigurationProposal,
} from "../configuration-proposal-tool.js";
import { ADAPTER_SEND_TOOLS_MCP_SERVER_NAME } from "../adapter-send-tools.js";
import { initMonoAgentFolder } from "../init.js";
import {
  applyJsonPatch,
  createLocalConfigurationRuntimeExtension,
  createLocalConfigurationSession,
  createRemoteConfigurationSession,
  isLocalConfigurationRequest,
  LOCAL_CONFIGURATION_OPERATOR_PROMPT,
  LOCAL_CONFIGURATION_PROMPT,
  LocalConfigurationManager,
} from "../local-configuration.js";
import { readMonoAgentConfigJson, type MonoAgentConfigJson } from "@mono-agent/config";
import { RUN_HISTORY_MCP_SERVER_NAME, RUN_HISTORY_TOOL_NAME } from "../run-history.js";
import { defaultAnswers } from "../wizard/answers.js";
import { captureBackgroundSnapshot, type BackgroundSnapshot } from "../background-snapshot.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scaffold(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-local-config-"));
  dirs.push(dir);
  const result = await initMonoAgentFolder({
    dir,
    answers: defaultAnswers({ name: "Local Test", purpose: "Help test local configuration." }),
  });
  return { dir, configPath: result.configPath };
}

function proposal(
  baseVersion: string,
  overrides: Partial<AgentConfigurationProposal> = {},
): AgentConfigurationProposal {
  return {
    schema: "mono-agent.configuration-proposal.v1",
    id: "11111111-2222-4333-8444-555555555555",
    baseVersion,
    rationale: "Use a clearer public name.",
    patch: [{ op: "replace", path: "/agent/name", value: "Clear Local Test" }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function writeProposalSink(
  dir: string,
  sessionId: string,
  value: AgentConfigurationProposal,
  suffix = "test",
): Promise<void> {
  await writeFile(
    join(dir, ".mono-agent", "configuration-proposals", `session-${sessionId}`, `proposal-${suffix}.json`),
    `${JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
}

describe("RFC 6902 configuration proposals", () => {
  it("enables the proposal boundary only for a TUI turn with an opaque configuration capability", () => {
    const marked = {
      source: "tui",
      tui: {
        configuration: true,
        configurationSessionId: "11111111-2222-4333-8444-555555555555",
        configurationPhase: "operator",
      },
    };
    expect(isLocalConfigurationRequest(marked)).toBe(true);
    expect(isLocalConfigurationRequest({ source: "tui", tui: { configuration: true } })).toBe(false);
    expect(isLocalConfigurationRequest({ source: "tui", tui: { ...marked.tui, configurationPhase: "unknown" } })).toBe(false);
    expect(isLocalConfigurationRequest({ source: "telegram", tui: marked.tui })).toBe(false);
  });

  it("applies add/remove/replace/copy/move/test without mutating the source", () => {
    const source = { agent: { name: "A" }, tools: { allowedTools: ["Read", "Grep"] } };
    const result = applyJsonPatch(source, [
      { op: "test", path: "/agent/name", value: "A" },
      { op: "replace", path: "/agent/name", value: "B" },
      { op: "add", path: "/tools/allowedTools/-", value: "Glob" },
      { op: "copy", from: "/agent/name", path: "/agent/alias" },
      { op: "move", from: "/agent/alias", path: "/agent/display" },
      { op: "remove", path: "/tools/allowedTools/1" },
    ]);
    expect(result).toMatchObject({ agent: { name: "B", display: "B" }, tools: { allowedTools: ["Read", "Glob"] } });
    expect(source.agent.name).toBe("A");
  });

  it("rejects prototype paths and failed tests", () => {
    expect(() => applyJsonPatch({}, [{ op: "add", path: "/__proto__/polluted", value: true }]))
      .toThrow(/Unsafe JSON Pointer/u);
    expect(() => applyJsonPatch({ agent: { name: "A" } }, [{ op: "test", path: "/agent/name", value: "B" }]))
      .toThrow(/test failed/u);
  });
});

describe("local configuration transaction", () => {
  it("prompts a persistent, user-led workflow conversation across every capability area", () => {
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("dedicated self-configuration session");
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("identity and knowledge; runtime and models");
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("skills, tools, MCP servers, and plugins");
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("channels, APIs, and A2A");
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("security, sandboxing, and secrets");
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("observability and operations; and acceptance criteria");
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("trigger → context/data → tools/actions → delivery → memory → safety/operations → success checks");
    expect(LOCAL_CONFIGURATION_PROMPT).toContain("approval, rejection, done, or no changes keeps SELF-CONFIG active");
    expect(LOCAL_CONFIGURATION_OPERATOR_PROMPT).toContain("do not repeat");
    expect(LOCAL_CONFIGURATION_OPERATOR_PROMPT).toContain("After a host-applied or rejected proposal, continue");
  });

  it("classifies configuration authority from the worker's frozen config", async () => {
    const { dir, configPath } = await scaffold();
    const canonical = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    const configReadPath = join(dir, "frozen-mono-agent.config.json");
    await writeFile(configReadPath, `${JSON.stringify({
      ...canonical,
      runtime: { ...canonical.runtime, model: "pi:openai-codex:gpt-5.5" },
    }, null, 2)}\n`, { mode: 0o400 });
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      await writeFile(configPath, `${JSON.stringify({
        ...canonical,
        runtime: { ...canonical.runtime, model: "codex:gpt-5.6-sol" },
      }, null, 2)}\n`);
      const extension = createLocalConfigurationRuntimeExtension({
        cwd: dir,
        configPath,
        configReadPath,
        env: {},
      });
      const result = await extension({
        request: {
          metadata: {
            source: "tui",
            tui: {
              configuration: true,
              configurationSessionId: manager.sessionId,
              configurationPhase: "operator",
            },
          },
        },
        runId: "frozen-route-authority",
        context: {},
      } as never);

      expect(result.toolPolicyOverride?.allowedTools).toEqual([
        "ReadSkill",
        "MemoryRecall",
        CONFIGURATION_PROPOSAL_TOOL_NAME,
        "mcp__agent_configuration__ProposeAgentConfiguration",
      ]);
      expect(result.toolPolicyOverride?.allowedTools).not.toContain("*");
    } finally {
      await manager.dispose();
    }
  });

  it("replaces ordinary tool/MCP authority with a read-only configuration boundary", async () => {
    const inspectExtension = async (model?: string, fallbackModels?: readonly string[]) => {
      const { dir, configPath } = await scaffold();
      const mcpPath = join(dir, "mcp.json");
      await writeFile(mcpPath, `${JSON.stringify({
        allowedTools: ["*"],
        mcpServers: { configuredMutator: { command: "configured-mutator" } },
      }, null, 2)}\n`);
      const raw = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
      await writeFile(configPath, `${JSON.stringify({
        ...raw,
        ...(model === undefined && fallbackModels === undefined
          ? {}
          : {
              runtime: {
                ...raw.runtime,
                ...(model === undefined ? {} : { model }),
                ...(fallbackModels === undefined ? {} : { fallbackModels }),
              },
            }),
        tools: { allowedTools: ["*"], disallowedTools: [], mcpConfigPath: "./mcp.json" },
      }, null, 2)}\n`);
      const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
      const extension = createLocalConfigurationRuntimeExtension({ cwd: dir, configPath, env: {} });
      const metadata = (phase: "invitation" | "operator") => ({
        source: "tui",
        tui: {
          configuration: true,
          configurationSessionId: manager.sessionId,
          configurationPhase: phase,
        },
      });
      return { dir, manager, extension, metadata };
    };

    const direct = await inspectExtension();
    try {
      const invitation = await direct.extension({
        request: { metadata: direct.metadata("invitation") },
        runId: "direct-invitation",
        context: {},
      } as never);
      expect(invitation.runtimeOptions).toMatchObject({ permissionMode: "plan" });
      expect(invitation.toolPolicyOverride?.allowedTools).toEqual(["*"]);
      expect(invitation.toolPolicyOverride?.mcpServers).toEqual({});

      const extension = await direct.extension({
        request: { metadata: direct.metadata("operator") },
        runId: "direct-config",
        context: {},
      } as never);
      expect(extension.runtimeOptions).toMatchObject({ permissionMode: "plan" });
      expect(extension.toolPolicyOverride?.allowedTools).toEqual(["*"]);
      expect(Object.keys(extension.toolPolicyOverride?.mcpServers ?? {})).toEqual(["agent_configuration"]);
      expect(extension.toolPolicyOverride?.mcpConfigPath).toBeUndefined();

      const ordinary = await direct.extension({
        request: { metadata: { source: "tui" } },
        runId: "ordinary",
        context: {},
      } as never);
      expect(ordinary).toEqual({ runtimeOptions: {} });
    } finally {
      await direct.manager.dispose();
    }
    await expect(direct.extension({
      request: { metadata: direct.metadata("operator") },
      runId: "late-config",
      context: {},
    } as never)).rejects.toThrow(/Configuration proposal session|ENOENT/u);

    const pi = await inspectExtension("pi:openai-codex:gpt-5.5");
    try {
      const invitation = await pi.extension({
        request: { metadata: pi.metadata("invitation") },
        runId: "pi-invitation",
        context: {},
      } as never);
      expect(invitation.toolPolicyOverride?.allowedTools).toEqual(["ReadSkill", "MemoryRecall"]);
      expect(invitation.toolPolicyOverride?.mcpServers).toEqual({});

      const extension = await pi.extension({
        request: { metadata: pi.metadata("operator") },
        runId: "pi-config",
        context: {},
      } as never);
      expect(extension.toolPolicyOverride?.allowedTools).toEqual([
        "ReadSkill",
        "MemoryRecall",
        CONFIGURATION_PROPOSAL_TOOL_NAME,
        "mcp__agent_configuration__ProposeAgentConfiguration",
      ]);
      expect(extension.toolPolicyOverride?.allowedTools).not.toEqual(expect.arrayContaining([
        "Bash",
        "Write",
        "Edit",
      ]));
      expect(Object.keys(extension.toolPolicyOverride?.mcpServers ?? {})).toEqual(["agent_configuration"]);
    } finally {
      await pi.manager.dispose();
    }

    const mixed = await inspectExtension("codex:gpt-5.6-sol", [
      "pi:openai-codex:gpt-5.5",
      "claude:claude-sonnet-4-6",
    ]);
    try {
      const invitation = await mixed.extension({
        request: { metadata: mixed.metadata("invitation") },
        runId: "mixed-invitation",
        context: {},
      } as never);
      expect(invitation.toolPolicyOverride?.allowedTools).toEqual(["ReadSkill", "MemoryRecall"]);

      const operator = await mixed.extension({
        request: { metadata: mixed.metadata("operator") },
        runId: "mixed-operator",
        context: {},
      } as never);
      expect(operator.toolPolicyOverride?.allowedTools).toEqual([
        "ReadSkill",
        "MemoryRecall",
        CONFIGURATION_PROPOSAL_TOOL_NAME,
        "mcp__agent_configuration__ProposeAgentConfiguration",
      ]);
      expect(operator.toolPolicyOverride?.allowedTools).not.toContain("*");
    } finally {
      await mixed.manager.dispose();
    }

    const reroutedOpenCode = await inspectExtension("opencode:github-copilot:gpt-5.1", [
      "pi:openai-codex:gpt-5.5",
    ]);
    try {
      const operator = await reroutedOpenCode.extension({
        request: { metadata: reroutedOpenCode.metadata("operator") },
        runId: "opencode-rerouted",
        context: {},
      } as never);
      expect(operator.runtimeOptions).toMatchObject({
        permissionMode: "plan",
        model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5" },
      });
      expect(operator.toolPolicyOverride?.allowedTools).not.toContain("*");
      expect(Object.keys(operator.toolPolicyOverride?.mcpServers ?? {})).toEqual(["agent_configuration"]);
    } finally {
      await reroutedOpenCode.manager.dispose();
    }

    const unsupportedOpenCode = await inspectExtension("opencode:github-copilot:gpt-5.1");
    try {
      await expect(unsupportedOpenCode.extension({
        request: { metadata: unsupportedOpenCode.metadata("invitation") },
        runId: "opencode-unsupported",
        context: {},
      } as never)).rejects.toThrow(/cannot receive the host-owned proposal MCP capability/u);
    } finally {
      await unsupportedOpenCode.manager.dispose();
    }

    const unsafeOpenCodeFallback = await inspectExtension("pi:openai-codex:gpt-5.5", [
      "opencode:github-copilot:gpt-5.1",
    ]);
    try {
      await expect(unsafeOpenCodeFallback.extension({
        request: { metadata: unsafeOpenCodeFallback.metadata("invitation") },
        runId: "opencode-unsafe-fallback",
        context: {},
      } as never)).rejects.toThrow(/fallback chain contains direct OpenCode/u);
    } finally {
      await unsafeOpenCodeFallback.manager.dispose();
    }
  });

  it("builds an OS-owner-local responder and refuses a writable-by-others folder", async () => {
    const { dir, configPath } = await scaffold();
    const session = await createLocalConfigurationSession({ cwd: dir, configPath, env: {}, configure: false });
    expect(session.title).toBe("Local Test");
    await session.dispose();

    await chmod(dir, 0o777);
    await expect(createLocalConfigurationSession({ cwd: dir, configPath, env: {} }))
      .rejects.toThrow(/group\/world writable/u);
  });

  it("applies through the host, proves a fresh background endpoint, and continues self-configuration", async () => {
    const { dir, configPath } = await scaffold();
    const restartSnapshots: BackgroundSnapshot[] = [];
    const session = await createRemoteConfigurationSession({
      cwd: dir,
      configPath,
      env: {},
      restartBackground: async (snapshot) => {
        restartSnapshots.push(snapshot);
        return {
          ok: true,
          connection: { baseUrl: "http://127.0.0.1:7001/gui", apiKey: "local-test-key" },
        };
      },
    });
    try {
      const version = (await readMonoAgentConfigJson(configPath)).version;
      await writeProposalSink(dir, session.configuration.sessionId, proposal(version));
      const card = await session.configuration.takeProposal();
      expect(card?.details).toContain("replace /agent/name = \"Clear Local Test\"");
      const result = await session.configuration.approve(card!.id);
      expect(result).toMatchObject({
        kind: "applied",
        connection: { baseUrl: "http://127.0.0.1:7001/gui", apiKey: "local-test-key" },
      });
      expect(result.message).toContain("background agent restarted successfully");
      expect(result.message).toContain("Self-configuration remains active");
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("Clear Local Test");
      expect(restartSnapshots).toHaveLength(1);
      expect(restartSnapshots[0]?.configPath).toBe(await realpath(configPath));
      expect(restartSnapshots[0]?.configFingerprint).toBe((await captureBackgroundSnapshot({
        cwd: dir,
        configPath: await realpath(configPath),
        env: {},
      })).configFingerprint);
    } finally {
      await session.dispose();
    }
  });

  it("preserves the caller's already-reconstructed durable environment without rereading dotenv", async () => {
    const { dir, configPath } = await scaffold();
    await writeFile(join(dir, ".env"), "TEST_API_KEY=stale-dotenv-value\n", { mode: 0o600 });
    const session = await createRemoteConfigurationSession({
      cwd: dir,
      configPath,
      env: { TEST_API_KEY: "caller-only-secret-value" },
      restartBackground: async () => ({
        ok: true,
        connection: { baseUrl: "http://127.0.0.1:7001/gui" },
      }),
    });
    try {
      const version = (await readMonoAgentConfigJson(configPath)).version;
      await writeProposalSink(dir, session.configuration.sessionId, proposal(version, {
        id: "22222222-2222-4222-8222-222222222222",
        rationale: "caller-only-secret-value",
      }));
      await expect(session.configuration.takeProposal()).rejects.toThrow(/appears to contain a secret/u);
    } finally {
      await session.dispose();
    }
  });

  it("preserves an applied result and fresh endpoint when post-result capability rotation fails", async () => {
    const { dir, configPath } = await scaffold();
    let restarts = 0;
    let rotationAttempts = 0;
    const session = await createRemoteConfigurationSession({
      cwd: dir,
      configPath,
      env: {},
      beforeRotateAttempt: () => {
        rotationAttempts += 1;
        throw new Error("synthetic capability rotation failure");
      },
      restartBackground: async () => {
        restarts += 1;
        return {
          ok: true,
          connection: { baseUrl: "http://127.0.0.1:7004/gui", apiKey: "fresh-key" },
        };
      },
    });
    try {
      const firstSessionId = session.configuration.sessionId;
      const version = (await readMonoAgentConfigJson(configPath)).version;
      await writeProposalSink(dir, firstSessionId, proposal(version));
      const card = await session.configuration.takeProposal();
      const result = await session.configuration.approve(card!.id);

      expect(result).toMatchObject({
        kind: "applied",
        connection: { baseUrl: "http://127.0.0.1:7004/gui", apiKey: "fresh-key" },
      });
      expect(result.message).toContain("background agent restarted successfully");
      expect(result.message).toContain("Self-configuration cannot continue safely in this console");
      expect(result.message).toContain("synthetic capability rotation failure");
      expect(restarts).toBe(1);
      expect(rotationAttempts).toBe(1);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("Clear Local Test");

      const disabledSessionId = session.configuration.sessionId;
      expect(disabledSessionId).not.toBe(firstSessionId);
      await expect(writeProposalSink(dir, disabledSessionId, proposal(version), "disabled"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(session.configuration.takeProposal()).rejects.toThrow(/continuation is disabled/u);
    } finally {
      await session.dispose();
    }
  });

  it("rolls approved files back, restores the old background endpoint, and reports recovery", async () => {
    const { dir, configPath } = await scaffold();
    let restarts = 0;
    const restartSnapshots: BackgroundSnapshot[] = [];
    const session = await createRemoteConfigurationSession({
      cwd: dir,
      configPath,
      env: {},
      restartBackground: async (snapshot) => {
        restarts += 1;
        restartSnapshots.push(snapshot);
        return restarts === 1
          ? { ok: false, message: "Recovery commands: mono-agent status; mono-agent logs --follow." }
          : { ok: true, connection: { baseUrl: "http://127.0.0.1:7002/gui" } };
      },
    });
    try {
      const version = (await readMonoAgentConfigJson(configPath)).version;
      await writeProposalSink(dir, session.configuration.sessionId, proposal(version));
      const card = await session.configuration.takeProposal();
      const result = await session.configuration.approve(card!.id);
      expect(restarts).toBe(2);
      expect(result).toMatchObject({
        kind: "rolled_back",
        connection: { baseUrl: "http://127.0.0.1:7002/gui" },
      });
      expect(result.message).toContain("approved files were restored");
      expect(result.message).toContain("previous background agent was restarted");
      expect(result.message).toContain("mono-agent logs --follow");
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("Local Test");
      expect(restartSnapshots).toHaveLength(2);
      expect(restartSnapshots[0]?.configFingerprint).not.toBe(restartSnapshots[1]?.configFingerprint);
      expect(restartSnapshots[1]?.configFingerprint).toBe((await captureBackgroundSnapshot({
        cwd: dir,
        configPath: await realpath(configPath),
        env: {},
      })).configFingerprint);
    } finally {
      await session.dispose();
    }
  });

  it("revokes and rotates the owner-only proposal capability after every configuration attempt", async () => {
    const { dir, configPath } = await scaffold();
    const session = await createRemoteConfigurationSession({
      cwd: dir,
      configPath,
      env: {},
      restartBackground: async () => ({ ok: true, connection: { baseUrl: "http://127.0.0.1:7003/gui" } }),
    });
    try {
      const first = session.configuration.sessionId;
      await expect(session.configuration.takeProposal()).resolves.toBeUndefined();
      const second = session.configuration.sessionId;
      expect(second).not.toBe(first);

      const version = (await readMonoAgentConfigJson(configPath)).version;
      await expect(writeProposalSink(dir, first, proposal(version), "late-first"))
        .rejects.toMatchObject({ code: "ENOENT" });

      await writeProposalSink(dir, second, proposal(version), "second");
      const card = await session.configuration.takeProposal();
      expect(card).toBeDefined();
      expect(session.configuration.sessionId).toBe(second);
      await session.configuration.reject(card!.id);
      const third = session.configuration.sessionId;
      expect(third).not.toBe(second);

      await session.configuration.abandon();
      expect(session.configuration.sessionId).not.toBe(third);
      await expect(writeProposalSink(dir, third, proposal(version), "late-third"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.dispose();
    }
  });

  it("consumes duplicate proposal sinks so a later configuration attempt is not poisoned", async () => {
    const { dir, configPath } = await scaffold();
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {} });
    try {
      const version = (await readMonoAgentConfigJson(configPath)).version;
      await writeProposalSink(dir, manager.sessionId, proposal(version), "one");
      await writeProposalSink(dir, manager.sessionId, proposal(version, { id: "22222222-2222-4222-8222-222222222222" }), "two");
      await expect(manager.takeProposal()).rejects.toThrow(/more than one proposal/u);
      await expect(manager.takeProposal()).resolves.toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("rejects config, Identity, and transaction paths that traverse symlinked parents", async () => {
    const first = await scaffold();
    const externalIdentityDir = await mkdtemp(join(tmpdir(), "mono-agent-external-identity-"));
    dirs.push(externalIdentityDir);
    const identityPath = join(first.dir, "IDENTITY.md");
    const externalIdentityPath = join(externalIdentityDir, "IDENTITY.md");
    const identityBefore = await readFile(identityPath, "utf8");
    await writeFile(externalIdentityPath, identityBefore);
    await symlink(externalIdentityDir, join(first.dir, "linked"), "dir");
    const currentConfig = JSON.parse(await readFile(first.configPath, "utf8")) as MonoAgentConfigJson;
    const config: MonoAgentConfigJson = {
      ...currentConfig,
      context: { ...currentConfig.context, identityPath: "./linked/IDENTITY.md" },
    };
    await writeFile(first.configPath, `${JSON.stringify(config, null, 2)}\n`);

    const manager = await LocalConfigurationManager.create({
      cwd: first.dir,
      configPath: first.configPath,
      env: {},
      configure: true,
    });
    try {
      const version = (await readMonoAgentConfigJson(first.configPath)).version;
      await expect(manager.prepareProposal(proposal(version, { role: "Do not escape the agent." })))
        .rejects.toThrow(/symbolic link|real directory/u);
      expect(await readFile(externalIdentityPath, "utf8")).toBe(identityBefore);
    } finally {
      await manager.dispose();
    }

    const second = await scaffold();
    const externalConfigDir = await mkdtemp(join(tmpdir(), "mono-agent-external-config-"));
    dirs.push(externalConfigDir);
    await writeFile(
      join(externalConfigDir, "mono-agent.config.json"),
      await readFile(second.configPath, "utf8"),
    );
    await symlink(externalConfigDir, join(second.dir, "linked-config"), "dir");
    await expect(LocalConfigurationManager.create({
      cwd: second.dir,
      configPath: join(second.dir, "linked-config", "mono-agent.config.json"),
      env: {},
      configure: true,
    })).rejects.toThrow(/symbolic link|real directory/u);

    const third = await scaffold();
    const externalStateDir = await mkdtemp(join(tmpdir(), "mono-agent-external-state-"));
    dirs.push(externalStateDir);
    await rm(join(third.dir, ".mono-agent"), { recursive: true, force: true });
    await symlink(externalStateDir, join(third.dir, ".mono-agent"), "dir");
    await expect(LocalConfigurationManager.create({
      cwd: third.dir,
      configPath: third.configPath,
      env: {},
      configure: true,
    })).rejects.toThrow(/real directory/u);
  });

  it("validates, applies, retains rollback evidence, and replaces only the Role body", async () => {
    const { dir, configPath } = await scaffold();
    const version = (await readMonoAgentConfigJson(configPath)).version;
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      await expect(manager.prepareProposal(proposal(version, {
        id: "oversized-role",
        role: "x".repeat(8_001),
      }))).rejects.toThrow(/8,000-character review limit/u);
      await expect(manager.prepareProposal(proposal(version, {
        id: "unsafe-role-control",
        role: "Visible Role text.\n\u001b[2Jspoofed approval",
      }))).rejects.toThrow(/Role contains unsafe terminal or bidi control/u);
      await expect(manager.prepareProposal(proposal(version, {
        id: "unsafe-rationale-control",
        rationale: "Visible rationale.\u0007spoofed approval",
      }))).rejects.toThrow(/rationale contains unsafe terminal or bidi control/u);
      const exactRole = "Help the operator test configuration safely.\nPreserve café and emoji 👋 exactly.";
      const card = await manager.prepareProposal(proposal(version, {
        role: exactRole,
      }));
      expect(card.details).toContain("replace /agent/name = \"Clear Local Test\"");
      expect(card.details).toContain("replace IDENTITY.md → ## Role");
      expect(card.role).toEqual({
        location: "IDENTITY.md → ## Role",
        proposedBody: exactRole,
      });

      const applied = await manager.apply(card.id);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("Clear Local Test");
      const identity = await readFile(join(dir, "IDENTITY.md"), "utf8");
      expect(identity).toContain(`## Role\n\n${exactRole}`);
      expect(identity).toContain("## Knowledge");
      expect(await readFile(join(applied.rollbackDir, "mono-agent.config.json.before"), "utf8"))
        .toContain('"name": "Local Test"');
      expect(await readFile(join(applied.rollbackDir, "change.json"), "utf8"))
        .toContain(applied.changeId);
    } finally {
      await manager.dispose();
    }
  });

  it("renders and applies a Role-only proposal against the configured custom identity path", async () => {
    const { dir, configPath } = await scaffold();
    await mkdir(join(dir, "identity"));
    const customIdentity = join(dir, "identity", "operator.md");
    await rename(join(dir, "IDENTITY.md"), customIdentity);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...raw,
      context: { ...raw.context, identityPath: "./identity/operator.md" },
    }, null, 2)}\n`);
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {} });
    try {
      expect(manager.roleLocation).toBe("identity/operator.md → ## Role");
      const version = (await readMonoAgentConfigJson(configPath)).version;
      const card = await manager.prepareProposal(proposal(version, {
        patch: [],
        role: "Operate from the configured custom identity document.",
      }));
      expect(card.details).toEqual(["replace identity/operator.md → ## Role"]);
      expect(card.role).toEqual({
        location: "identity/operator.md → ## Role",
        proposedBody: "Operate from the configured custom identity document.",
      });
      const applied = await manager.apply(card.id);
      expect(await readFile(customIdentity, "utf8")).toContain(
        "## Role\n\nOperate from the configured custom identity document.",
      );
      expect(await readFile(join(applied.rollbackDir, "identity-document.before"), "utf8"))
        .toContain("## Role");

      await writeFile(customIdentity, "# Custom identity\n\nNo canonical Role section is present.\n");
      await expect(manager.prepareProposal(proposal(version, {
        id: "missing-custom-role",
        patch: [],
        role: "This replacement cannot be anchored safely.",
      }))).rejects.toThrow("The configured identity document has no canonical ## Role section to replace safely.");
    } finally {
      await manager.dispose();
    }
  });

  it("rejects stale, env-shadowed, secret-bearing, and authority-expanding proposals", async () => {
    const { dir, configPath } = await scaffold();
    const scaffolded = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...scaffolded,
      runtime: { ...scaffolded.runtime, model: "pi:openai-codex:gpt-5.5" },
      tools: { ...scaffolded.tools, allowedTools: ["ReadSkill"] },
    }, null, 2)}\n`);
    const first = await readMonoAgentConfigJson(configPath);

    const envManager = await LocalConfigurationManager.create({
      cwd: dir,
      configPath,
      env: { MONO_AGENT_NAME: "Environment Name", OPENAI_API_KEY: "configured-secret" },
      configure: true,
    });
    try {
      await expect(envManager.prepareProposal(proposal(first.version))).rejects.toThrow(/environment overrides/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "secret-proposal",
        patch: [{ op: "add", path: "/memory/embeddings/apiKey", value: "configured-secret" }],
      }))).rejects.toThrow(/Secret-bearing|secret value/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "authority-proposal",
        patch: [{ op: "add", path: "/tools/allowedTools/-", value: "Bash" }],
      }))).rejects.toThrow(/Broader tool authority/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "permission-proposal",
        patch: [{ op: "add", path: "/runtime/permissionMode", value: "bypassPermissions" }],
      }))).rejects.toThrow(/permissionMode/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "route-safety-proposal",
        patch: [{ op: "replace", path: "/runtime/routeSafety", value: "per-route-native" }],
      }))).rejects.toThrow(/routeSafety|guided flow/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "cron-proposal",
        patch: [{
          op: "add",
          path: "/cron",
          value: { jobs: [{ id: "unattended", expression: "* * * * *", prompt: "Run unattended." }] },
        }],
      }))).rejects.toThrow(/cron|guided flow/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "telegram-proposal",
        patch: [{ op: "add", path: "/telegram", value: { enabled: true, allowedUserIds: ["123"] } }],
      }))).rejects.toThrow(/telegram|guided flow/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "plugin-proposal",
        patch: [{ op: "add", path: "/channels", value: { plugins: [{ package: "example-channel" }] } }],
      }))).rejects.toThrow(/channels|guided flow/u);

      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "permission-tightening",
        patch: [{ op: "add", path: "/runtime/permissionMode", value: "plan" }],
      }))).rejects.toThrow(/permissionMode|guided flow/u);
    } finally {
      await envManager.dispose();
    }

    const staleManager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const card = await staleManager.prepareProposal(proposal(first.version));
      const raw = JSON.parse(await readFile(configPath, "utf8")) as { traceability: Record<string, unknown> };
      raw.traceability.heartbeatMs = 1234;
      await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
      await expect(staleManager.apply(card.id)).rejects.toThrow(/changed after the proposal/u);
    } finally {
      await staleManager.dispose();
    }
  });

  it("preserves config and Role edits made during approval validation", async () => {
    const configRace = await scaffold();
    const configVersion = (await readMonoAgentConfigJson(configRace.configPath)).version;
    const configManager = await LocalConfigurationManager.create({
      cwd: configRace.dir,
      configPath: configRace.configPath,
      env: {},
      configure: true,
    });
    try {
      const card = await configManager.prepareProposal(proposal(configVersion));
      const internals = configManager as unknown as {
        validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void>;
      };
      const validate = internals.validateCandidate.bind(configManager);
      internals.validateCandidate = async (candidate, label) => {
        await validate(candidate, label);
        if (label.endsWith("-approval")) {
          const current = JSON.parse(await readFile(configRace.configPath, "utf8")) as MonoAgentConfigJson;
          const concurrent: MonoAgentConfigJson = { ...current, agent: { name: "CONCURRENT-EDIT" } };
          await writeFile(configRace.configPath, `${JSON.stringify(concurrent, null, 2)}\n`);
        }
      };
      await expect(configManager.apply(card.id)).rejects.toThrow(/changed while the approved change was being prepared/u);
      expect((await readMonoAgentConfigJson(configRace.configPath)).json.agent?.name).toBe("CONCURRENT-EDIT");
    } finally {
      await configManager.dispose();
    }

    const roleRace = await scaffold();
    const rolePath = join(roleRace.dir, "IDENTITY.md");
    const roleVersion = (await readMonoAgentConfigJson(roleRace.configPath)).version;
    const roleManager = await LocalConfigurationManager.create({
      cwd: roleRace.dir,
      configPath: roleRace.configPath,
      env: {},
      configure: true,
    });
    try {
      const card = await roleManager.prepareProposal(proposal(roleVersion, {
        role: "Apply only if the source Role is still current.",
      }));
      const internals = roleManager as unknown as {
        validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void>;
      };
      const validate = internals.validateCandidate.bind(roleManager);
      internals.validateCandidate = async (candidate, label) => {
        await validate(candidate, label);
        if (label.endsWith("-approval")) await writeFile(rolePath, "# CONCURRENT ROLE EDIT\n");
      };
      await expect(roleManager.apply(card.id)).rejects.toThrow(/Configured identity document changed while/u);
      expect(await readFile(rolePath, "utf8")).toBe("# CONCURRENT ROLE EDIT\n");
      expect((await readMonoAgentConfigJson(roleRace.configPath)).json.agent?.name).toBe("Local Test");
    } finally {
      await roleManager.dispose();
    }
  });

  it("refuses an unapproved edit made between evidence write and snapshot capture", async () => {
    const { dir, configPath } = await scaffold();
    const current = await readMonoAgentConfigJson(configPath);
    const concurrent: MonoAgentConfigJson = {
      ...current.json,
      agent: { ...current.json.agent, name: "CONCURRENT-BEFORE-SNAPSHOT" },
    };
    const manager = await LocalConfigurationManager.create({
      cwd: dir,
      configPath,
      env: {},
      configure: true,
      beforeSnapshotCapture: async (phase) => {
        if (phase === "apply") {
          await writeFile(configPath, `${JSON.stringify(concurrent, null, 2)}\n`);
        }
      },
    });
    try {
      const card = await manager.prepareProposal(proposal(current.version));
      await expect(manager.apply(card.id)).rejects.toThrow(/concurrent edits were preserved|Manual recovery/u);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("CONCURRENT-BEFORE-SNAPSHOT");
    } finally {
      await manager.dispose();
    }
  });

  it("does not restart an unapproved edit raced into the restored rollback snapshot", async () => {
    const { dir, configPath } = await scaffold();
    const original = await readMonoAgentConfigJson(configPath);
    let restarts = 0;
    const session = await createRemoteConfigurationSession({
      cwd: dir,
      configPath,
      env: {},
      beforeSnapshotCapture: async (phase) => {
        if (phase !== "rollback") return;
        const restored = await readMonoAgentConfigJson(configPath);
        await writeFile(configPath, `${JSON.stringify({
          ...restored.json,
          agent: { ...restored.json.agent, name: "CONCURRENT-AFTER-ROLLBACK" },
        }, null, 2)}\n`);
      },
      restartBackground: async () => {
        restarts += 1;
        return { ok: false, message: "synthetic approved restart failure" };
      },
    });
    try {
      await writeProposalSink(dir, session.configuration.sessionId, proposal(original.version));
      const card = await session.configuration.takeProposal();
      const result = await session.configuration.approve(card!.id);

      expect(result.kind).toBe("error");
      expect(result.message).toContain("automatic file rollback also failed");
      expect(restarts).toBe(1);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("CONCURRENT-AFTER-ROLLBACK");
    } finally {
      await session.dispose();
    }
  });

  it("preserves an edit made after the atomic temp is staged", async () => {
    const { dir, configPath } = await scaffold();
    const current = await readMonoAgentConfigJson(configPath);
    const concurrent: MonoAgentConfigJson = {
      ...current.json,
      agent: { ...current.json.agent, name: "CONCURRENT-EDIT" },
    };
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    let stop = false;
    let fired = false;
    try {
      const card = await manager.prepareProposal(proposal(current.version));
      const monitor = (async () => {
        while (!stop) {
          if (!fired && readdirSync(dir).some((name) => name.endsWith(".mono-agent-tmp"))) {
            fired = true;
            writeFileSync(configPath, `${JSON.stringify(concurrent, null, 2)}\n`);
          }
          await yieldNow();
        }
      })();

      let outcome: unknown;
      try {
        outcome = await manager.apply(card.id);
      } catch (error) {
        outcome = error;
      } finally {
        stop = true;
        await monitor;
      }
      expect(fired).toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("CONCURRENT-EDIT");
    } finally {
      stop = true;
      await manager.dispose();
    }
  });

  it("reapplies the approved Role when a concurrent config edit aborts rollback", async () => {
    const { dir, configPath } = await scaffold();
    const identityPath = join(dir, "IDENTITY.md");
    const identityBefore = await readFile(identityPath, "utf8");
    const current = await readMonoAgentConfigJson(configPath);
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    let stop = false;
    let fired = false;
    try {
      const card = await manager.prepareProposal(proposal(current.version, {
        role: "Keep the approved Role if automatic rollback cannot restore config.",
      }));
      const applied = await manager.apply(card.id);
      const approved = await readMonoAgentConfigJson(configPath);
      const concurrent: MonoAgentConfigJson = {
        ...approved.json,
        agent: { ...approved.json.agent, name: "CONCURRENT-ROLLBACK-EDIT" },
      };
      const approvedRole = await readFile(identityPath, "utf8");
      const monitor = (async () => {
        while (!stop) {
          if (!fired && readdirSync(dir).some((name) => name.endsWith(".mono-agent-tmp"))) {
            fired = true;
            writeFileSync(configPath, `${JSON.stringify(concurrent, null, 2)}\n`);
          }
          await yieldNow();
        }
      })();

      try {
        await expect(applied.rollback()).rejects.toThrow(/concurrent edit was preserved|Refusing to replace changed file/u);
      } finally {
        stop = true;
        await monitor;
      }
      expect(fired).toBe(true);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("CONCURRENT-ROLLBACK-EDIT");
      expect(await readFile(identityPath, "utf8")).toBe(approvedRole);
      expect(approvedRole).not.toBe(identityBefore);
    } finally {
      stop = true;
      await manager.dispose();
    }
  });

  it("uses a fail-closed allowlist for paths, endpoints, sandbox, and new schema fields", async () => {
    const { dir, configPath } = await scaffold();
    const external = await mkdtemp(join(tmpdir(), "mono-agent-external-memory-"));
    dirs.push(external);
    await symlink(external, join(dir, "linked-external"), "dir");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...raw,
      context: { ...raw.context, skillMaxBytes: 65_536 },
      memory: {
        mode: "journal",
        path: ".mono-agent/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          endpoint: "http://127.0.0.1:9999/v1",
          apiKeyEnv: "TEST_EMBEDDINGS_KEY",
        },
      },
    }, null, 2)}\n`);
    const current = await readMonoAgentConfigJson(configPath);
    const manager = await LocalConfigurationManager.create({
      cwd: dir,
      configPath,
      env: {
        TEST_EMBEDDINGS_KEY: "synthetic-not-real",
        MONO_AGENT_SKILL_MAX_BYTES: "131072",
      },
      configure: true,
    });
    try {
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "memory-path-escape",
        patch: [{ op: "replace", path: "/memory/path", value: "./linked-external" }],
      }))).rejects.toThrow(/memory\/path|Paths/u);
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "public-endpoint-fallback",
        patch: [{ op: "remove", path: "/memory/embeddings/endpoint" }],
      }))).rejects.toThrow(/embeddings\/endpoint|network/u);
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "sandbox-default-widening",
        patch: [{ op: "add", path: "/sandbox", value: { readableRoots: [], writableRoots: [] } }],
      }))).rejects.toThrow(/sandbox|guided flow/u);
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "unknown-future-field",
        patch: [{ op: "add", path: "/futureAuthority", value: true }],
      }))).rejects.toThrow(/futureAuthority|new schema fields/u);
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "env-shadowed-move-source",
        patch: [{ op: "move", from: "/context/skillMaxBytes", path: "/memory/maxBytes" }],
      }))).rejects.toThrow(/environment overrides|MONO_AGENT_SKILL_MAX_BYTES/u);
    } finally {
      await manager.dispose();
    }
  });

  it("rejects removing an exact MCP deny behind a server-wildcard allowlist", async () => {
    const { dir, configPath } = await scaffold();
    await writeFile(join(dir, "mcp.json"), `${JSON.stringify({
      allowedTools: ["*"],
      mcpServers: { danger: { command: "/usr/bin/false" } },
    }, null, 2)}\n`);
    const scaffolded = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...scaffolded,
      runtime: { ...scaffolded.runtime, model: "claude:claude-sonnet-4-6" },
      tools: {
        ...scaffolded.tools,
        allowedTools: ["*"],
        disallowedTools: ["mcp__danger__DeleteEverything"],
        mcpConfigPath: "./mcp.json",
      },
    }, null, 2)}\n`);
    const current = await readMonoAgentConfigJson(configPath);
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const tightening = await manager.prepareProposal(proposal(current.version, {
        id: "mcp-wildcard-deny-preserved",
        rationale: "Narrow tool access while preserving the exact MCP denial.",
        patch: [
          { op: "replace", path: "/tools/allowedTools", value: ["mcp__danger__*"] },
        ],
      }));
      await expect(manager.reject(tightening.id)).resolves.toMatchObject({ kind: "rejected" });

      await expect(manager.prepareProposal(proposal(current.version, {
        id: "mcp-wildcard-deny-removal",
        rationale: "Narrow tool access to the danger MCP server.",
        patch: [
          { op: "replace", path: "/tools/allowedTools", value: ["mcp__danger__*"] },
          { op: "replace", path: "/tools/disallowedTools", value: [] },
        ],
      }))).rejects.toThrow(/Broader tool authority/u);
    } finally {
      await manager.dispose();
    }
  });

  it("normalizes legacy aliases and Claude MCP server-wide deny patterns", async () => {
    const { dir, configPath } = await scaffold();
    const scaffolded = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    const base = {
      ...scaffolded,
      runtime: { ...scaffolded.runtime, model: "claude:claude-sonnet-4-6" },
    };
    await writeFile(configPath, `${JSON.stringify(base, null, 2)}\n`);
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const expansions = [
        {
          id: "legacy-slack-deny-removal",
          beforeDenied: ["slack_send_message"],
          afterAllowed: ["SlackSendMessage"],
        },
        {
          id: "legacy-slack-mcp-wildcard",
          beforeDenied: ["slack_send_message"],
          afterAllowed: [`mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__*`],
        },
        {
          id: "legacy-run-history-mcp-name",
          beforeDenied: ["run_history"],
          afterAllowed: [`mcp__${RUN_HISTORY_MCP_SERVER_NAME}__${RUN_HISTORY_TOOL_NAME}`],
        },
        {
          id: "collapsed-telegram-file-alias",
          beforeDenied: ["telegram_send_document"],
          afterAllowed: ["telegram_send_photo"],
        },
        {
          id: "claude-mcp-server-wide-deny",
          beforeDenied: ["mcp__danger"],
          afterAllowed: ["mcp__danger__*"],
        },
        {
          id: "claude-all-mcp-deny",
          beforeDenied: ["mcp__*"],
          afterAllowed: [RUN_HISTORY_TOOL_NAME],
        },
        {
          id: "claude-all-mcp-deny-generic-server",
          beforeDenied: ["mcp__*"],
          afterAllowed: ["mcp__danger__ReadEverything"],
        },
      ] as const;

      for (const expansion of expansions) {
        await writeFile(configPath, `${JSON.stringify({
          ...base,
          tools: {
            ...scaffolded.tools,
            allowedTools: ["*"],
            disallowedTools: expansion.beforeDenied,
          },
        }, null, 2)}\n`);
        const current = await readMonoAgentConfigJson(configPath);
        await expect(manager.prepareProposal(proposal(current.version, {
          id: expansion.id,
          patch: [
            { op: "replace", path: "/tools/allowedTools", value: expansion.afterAllowed },
            { op: "replace", path: "/tools/disallowedTools", value: [] },
          ],
        }))).rejects.toThrow(/Broader tool authority/u);
      }

      await writeFile(configPath, `${JSON.stringify({
        ...base,
        tools: {
          ...scaffolded.tools,
          allowedTools: ["slack_send_message"],
          disallowedTools: [],
        },
      }, null, 2)}\n`);
      const aliasVersion = await readMonoAgentConfigJson(configPath);
      const aliasRename = await manager.prepareProposal(proposal(aliasVersion.version, {
        id: "safe-canonical-alias-rename",
        patch: [{ op: "replace", path: "/tools/allowedTools", value: ["SlackSendMessage"] }],
      }));
      await expect(manager.reject(aliasRename.id)).resolves.toMatchObject({ kind: "rejected" });
    } finally {
      await manager.dispose();
    }
  });

  it("allows low-risk fields and semantic tool-authority tightening", async () => {
    const { dir, configPath } = await scaffold();
    const current = await readMonoAgentConfigJson(configPath);
    const seeded: MonoAgentConfigJson = {
      ...current.json,
      runtime: { ...current.json.runtime, model: "pi:openai-codex:gpt-5.5" },
      memory: {
        mode: "lite",
        path: ".mono-agent/memory",
        writeMode: "append-host-summary",
      },
      tools: { allowedTools: ["Read", "Grep"], disallowedTools: [] },
    };
    await writeFile(configPath, `${JSON.stringify(seeded, null, 2)}\n`);
    const seededVersion = (await readMonoAgentConfigJson(configPath)).version;
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const card = await manager.prepareProposal(proposal(seededVersion, {
        id: "safe-low-risk-fields",
        patch: [
          { op: "replace", path: "/agent/name", value: "Focused Local Test" },
          { op: "add", path: "/runtime/effort", value: "low" },
          { op: "replace", path: "/context/selectedSkills", value: ["mono-agent-configure"] },
          { op: "add", path: "/memory/maxBytes", value: 32_000 },
          { op: "add", path: "/memory/recallTool", value: { enabled: true } },
          { op: "replace", path: "/tools/allowedTools", value: ["Read"] },
          { op: "replace", path: "/tools/disallowedTools", value: ["Bash"] },
        ],
      }));
      await expect(manager.reject(card.id)).resolves.toMatchObject({ message: expect.stringContaining("Proposal rejected") });

      const fullDenyList = Array.from(
        { length: 24 },
        (_, index) => `ToolRule${String(index).padStart(2, "0")}-fully-visible-in-host-review`,
      );
      const fullReview = await manager.prepareProposal(proposal(seededVersion, {
        id: "full-authority-review",
        patch: [{ op: "replace", path: "/tools/disallowedTools", value: fullDenyList }],
      }));
      const rendered = `replace /tools/disallowedTools = ${JSON.stringify(fullDenyList)}`;
      expect(rendered.length).toBeGreaterThan(180);
      expect(fullReview.details).toContain(rendered);
      expect(fullReview.details.join("\n")).toContain(fullDenyList.at(-1));
      await expect(manager.reject(fullReview.id)).resolves.toMatchObject({ kind: "rejected" });
    } finally {
      await manager.dispose();
    }
  });

  it("rejects an Identity parent replaced by an external symlink at the commit boundary", async () => {
    const { dir, configPath } = await scaffold();
    const originalIdentityPath = join(dir, "IDENTITY.md");
    const identityBefore = await readFile(originalIdentityPath, "utf8");
    const identityDir = join(dir, "identity");
    await mkdir(identityDir);
    await writeFile(join(identityDir, "IDENTITY.md"), identityBefore);
    await rm(originalIdentityPath);
    const current = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...current,
      context: { ...current.context, identityPath: "./identity/IDENTITY.md" },
    }, null, 2)}\n`);

    const externalParent = await mkdtemp(join(tmpdir(), "mono-agent-identity-race-"));
    dirs.push(externalParent);
    const movedIdentityDir = join(externalParent, "identity");
    const version = (await readMonoAgentConfigJson(configPath)).version;
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const card = await manager.prepareProposal(proposal(version, {
        role: "This Role must never cross the project boundary.",
      }));
      const internals = manager as unknown as {
        validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void>;
      };
      const validate = internals.validateCandidate.bind(manager);
      internals.validateCandidate = async (candidate, label) => {
        await validate(candidate, label);
        if (label.endsWith("-approval")) {
          await rename(identityDir, movedIdentityDir);
          await symlink(movedIdentityDir, identityDir, "dir");
        }
      };

      await expect(manager.apply(card.id)).rejects.toThrow(/real directory|symbolic link/u);
      expect(await readFile(join(movedIdentityDir, "IDENTITY.md"), "utf8")).toBe(identityBefore);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("Local Test");
    } finally {
      await manager.dispose();
    }
  });
});

describe("ProposeAgentConfiguration MCP tool", () => {
  it("allows a Role-only proposal but rejects an empty no-op proposal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-proposal-role-only-"));
    dirs.push(dir);
    const roleSink = join(dir, "role.json");
    const roleServer = createConfigurationProposalServer({ sinkPath: roleSink, baseVersion: "base-hash" });
    const roleClient = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
    const [roleClientTransport, roleServerTransport] = InMemoryTransport.createLinkedPair();
    await roleServer.connect(roleServerTransport);
    await roleClient.connect(roleClientTransport);
    try {
      const result = await roleClient.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: { rationale: "Clarify the Role.", patch: [], role: "Give concise, evidence-led help." },
      }) as { isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(await readFile(roleSink, "utf8"))).toMatchObject({
        patch: [],
        role: "Give concise, evidence-led help.",
      });
    } finally {
      await roleClient.close();
      await roleServer.close();
    }

    const noOpSink = join(dir, "noop.json");
    const noOpServer = createConfigurationProposalServer({ sinkPath: noOpSink, baseVersion: "base-hash" });
    const noOpClient = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
    const [noOpClientTransport, noOpServerTransport] = InMemoryTransport.createLinkedPair();
    await noOpServer.connect(noOpServerTransport);
    await noOpClient.connect(noOpClientTransport);
    try {
      const result = await noOpClient.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: { rationale: "Change nothing.", patch: [] },
      }) as { isError?: boolean };
      expect(result.isError).toBe(true);
      await expect(readFile(noOpSink, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await noOpClient.close();
      await noOpServer.close();
    }
  });

  it("does not resurrect a removed owner session for a late proposal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-proposal-revoked-"));
    dirs.push(dir);
    const sessionDir = join(dir, "session-revoked");
    await mkdir(sessionDir, { mode: 0o700 });
    const sinkPath = join(sessionDir, "proposal.json");
    const server = createConfigurationProposalServer({ sinkPath, baseVersion: "base-hash" });
    const client = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await rm(sessionDir, { recursive: true, force: true });
    try {
      const result = await client.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: {
          rationale: "Arrived too late.",
          patch: [{ op: "replace", path: "/agent/name", value: "Late" }],
        },
      }) as { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(() => readdirSync(sessionDir)).toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects terminal and bidi control spoofing before writing review text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-proposal-review-controls-"));
    dirs.push(dir);
    const cases = [
      {
        name: "rationale-c0",
        arguments: {
          rationale: "Explain this.\u0007Spoof the decision.",
          patch: [{ op: "replace", path: "/agent/name", value: "Clear" }],
        },
      },
      {
        name: "rationale-trailing-cr",
        arguments: {
          rationale: "Explain this.\r",
          patch: [{ op: "replace", path: "/agent/name", value: "Clear" }],
        },
      },
      {
        name: "role-escape",
        arguments: {
          rationale: "Clarify the Role.",
          patch: [],
          role: "Visible Role text.\n\u001b[2Jspoofed approval",
        },
      },
      {
        name: "role-bidi",
        arguments: {
          rationale: "Clarify the Role.",
          patch: [],
          role: "Visible Role text.\u202espoofed approval",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const sinkPath = join(dir, `${testCase.name}.json`);
      const server = createConfigurationProposalServer({ sinkPath, baseVersion: "base-hash" });
      const client = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: CONFIGURATION_PROPOSAL_TOOL_NAME,
          arguments: testCase.arguments,
        }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toContain("unsafe terminal or bidi controls");
        await expect(readFile(sinkPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it("rejects secret-shaped fields before creating a proposal payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-proposal-secret-"));
    dirs.push(dir);
    const sinkPath = join(dir, "proposal.json");
    const server = createConfigurationProposalServer({ sinkPath, baseVersion: "base-hash" });
    const client = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === CONFIGURATION_PROPOSAL_TOOL_NAME)?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

      const result = await client.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: {
          rationale: "Put a key in config.",
          patch: [{ op: "add", path: "/memory/embeddings/apiKey", value: "sk-secret-shaped-value" }],
        },
      }) as { isError?: boolean };
      expect(result.isError).toBe(true);
      await expect(readFile(sinkPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("records one non-applying proposal for host validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-proposal-tool-"));
    dirs.push(dir);
    const sinkPath = join(dir, "proposal.json");
    const server = createConfigurationProposalServer({ sinkPath, baseVersion: "base-hash" });
    const client = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: {
          rationale: "Make the name clearer.",
          patch: [{ op: "replace", path: "/agent/name", value: "Clear" }],
        },
      }) as { structuredContent?: { proposalId?: string } };
      expect(result.structuredContent?.proposalId).toBeTypeOf("string");
      const stored = JSON.parse(await readFile(sinkPath, "utf8")) as AgentConfigurationProposal;
      expect(stored.baseVersion).toBe("base-hash");
      expect(stored.patch).toEqual([{ op: "replace", path: "/agent/name", value: "Clear" }]);

      const duplicate = await client.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: { rationale: "Again", patch: [{ op: "remove", path: "/agent/name" }] },
      }) as { isError?: boolean };
      expect(duplicate.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
