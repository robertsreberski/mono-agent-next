// The `"*"` allow-all sentinel must never reach a Claude flag/query literally.
// On the CLI, allow-all omits `--tools` (deferring to Claude Code's default
// toolset) while still emitting `--disallowedTools` and the per-MCP-server
// `mcp__<server>__*` auto-allow wildcards. On the SDK, allow-all maps to
// `allowedTools: undefined` (the SDK default = all tools, incl. Task).
import { describe, expect, it } from "vitest";
import { buildCliCommand } from "../../ai/providers/claude-cli.js";
import { resolveClaudeAllowedTools } from "../../ai/providers/claude-subagents.js";

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function cliSpec(overrides = {}) {
  return buildCliCommand({
    sdk: "claude-code",
    model: "claude-opus-4-7",
    systemPrompt: "sys",
    prompt: "hi",
    cwd: "/tmp",
    ...overrides,
  });
}

describe("claude-cli buildCliCommand — allowed/disallowed tools", () => {
  it("passes an explicit --tools list and --disallowedTools unchanged (no wildcard)", () => {
    const spec = cliSpec({ allowedTools: ["Read", "Bash"], disallowedTools: ["WebFetch"] });
    expect(flagValue(spec.args, "--tools")).toBe("Read,Bash");
    expect(flagValue(spec.args, "--disallowedTools")).toBe("WebFetch");
    // Explicit tools are also mirrored into the --allowedTools auto-approve list.
    expect(flagValue(spec.args, "--allowedTools")).toBe("Read Bash");
  });

  it('omits --tools under the "*" allow-all sentinel yet still emits --disallowedTools and MCP wildcards', () => {
    const spec = cliSpec({
      allowedTools: ["*"],
      disallowedTools: ["Bash"],
      mcpServers: { playwright: { type: "http", url: "http://127.0.0.1:9/mcp" } },
    });
    // A literal "*" never appears as a standalone arg (e.g. a `--tools *` value).
    expect(spec.args).not.toContain("--tools");
    expect(spec.args).not.toContain("*");
    // deny-wins is still enforced.
    expect(flagValue(spec.args, "--disallowedTools")).toBe("Bash");
    // MCP auto-allow wildcards survive; no bare "*" token leaks into the list.
    const allowed = (flagValue(spec.args, "--allowedTools") || "").split(" ");
    expect(allowed).toContain("mcp__playwright__*");
    expect(allowed).not.toContain("*");
  });

  it("omits both --tools and --allowedTools under allow-all with no MCP servers", () => {
    const spec = cliSpec({ allowedTools: ["*"] });
    expect(spec.args).not.toContain("--tools");
    expect(spec.args).not.toContain("--allowedTools");
    expect(spec.args).not.toContain("*");
  });
});

describe("resolveClaudeAllowedTools — SDK allow-all mapping", () => {
  it('flags allow-all and strips the bare "*" (SDK caller passes undefined)', () => {
    expect(resolveClaudeAllowedTools(["*"], null)).toEqual({ allowAll: true, tools: [] });
  });

  it("passes an explicit list through unchanged (not allow-all)", () => {
    expect(resolveClaudeAllowedTools(["Read", "Bash"], null)).toEqual({
      allowAll: false,
      tools: ["Read", "Bash"],
    });
  });

  it("leaves undefined as-is so the SDK uses its default toolset", () => {
    expect(resolveClaudeAllowedTools(undefined, null)).toEqual({ allowAll: false, tools: undefined });
  });

  it("flags allow-all with native subagents so the SDK defers to its default (Task comes from the default, not double-added)", () => {
    const nativeSubagents = {
      provider: "claude",
      teammates: [{ name: "helper", helperSystemPrompt: "do things" }],
    };
    const { allowAll, tools } = resolveClaudeAllowedTools(["*"], nativeSubagents);
    expect(allowAll).toBe(true);
    expect(tools).not.toContain("*");
  });
});
