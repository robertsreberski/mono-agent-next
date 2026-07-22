import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const CONFIGURATION_PROPOSAL_MCP_SERVER_NAME = "agent_configuration";
export const CONFIGURATION_PROPOSAL_TOOL_NAME = "ProposeAgentConfiguration";

const SINK_ENV = "MONO_AGENT_CONFIGURATION_PROPOSAL_SINK";
const BASE_VERSION_ENV = "MONO_AGENT_CONFIGURATION_BASE_VERSION";
const BIDI_CONTROL = /\p{Bidi_Control}/u;

export interface JsonPatchOperation {
  readonly op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  readonly path: string;
  readonly from?: string;
  readonly value?: unknown;
}

export interface AgentConfigurationProposal {
  readonly schema: "mono-agent.configuration-proposal.v1";
  readonly id: string;
  readonly baseVersion: string;
  readonly rationale: string;
  readonly patch: readonly JsonPatchOperation[];
  readonly role?: string;
  readonly createdAt: string;
}

export interface ConfigurationProposalChildSettings {
  readonly sinkPath: string;
  readonly baseVersion: string;
}

/**
 * Proposal copy is rendered in an out-of-band terminal approval card. Keep
 * ordinary Unicode text and LF newlines intact, but reject terminal controls
 * and bidi controls that could clear, overwrite, or visually reorder the
 * operator's review.
 */
export function containsUnsafeConfigurationReviewControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint <= 0x1f && codePoint !== 0x0a)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || BIDI_CONTROL.test(character)
    ) {
      return true;
    }
  }
  return false;
}

const patchOperationSchema = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string().min(1).max(500).startsWith("/"),
  from: z.string().min(1).max(500).startsWith("/").optional(),
  value: z.unknown().optional(),
}).superRefine((operation, context) => {
  if ((operation.op === "move" || operation.op === "copy") && operation.from === undefined) {
    context.addIssue({ code: "custom", message: `${operation.op} requires from.` });
  }
  if ((operation.op === "add" || operation.op === "replace" || operation.op === "test") && !("value" in operation)) {
    context.addIssue({ code: "custom", message: `${operation.op} requires value.` });
  }
});

const proposalInputSchema = {
  rationale: configurationReviewTextSchema(2_000, "Short operator-facing reason for this change."),
  patch: z.array(patchOperationSchema).max(50).describe("RFC 6902 patch against mono-agent.config.json. May be empty only for a Role-only proposal."),
  role: configurationReviewTextSchema(
    8_000,
    "Optional replacement body for the existing ## Role section in the configured identity document (normally IDENTITY.md).",
  ).optional(),
};

function configurationReviewTextSchema(maxLength: number, description: string) {
  return z.string()
    .superRefine((value, context) => {
      if (containsUnsafeConfigurationReviewControl(value)) {
        context.addIssue({
          code: "custom",
          message: "Configuration proposal review text contains unsafe terminal or bidi controls.",
        });
      }
    })
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(maxLength))
    .describe(description);
}

export function configurationProposalChildSettingsFromEnv(
  env: Record<string, string | undefined>,
): ConfigurationProposalChildSettings {
  const sinkPath = env[SINK_ENV]?.trim();
  const baseVersion = env[BASE_VERSION_ENV]?.trim();
  if (sinkPath === undefined || sinkPath.length === 0) {
    throw new Error(`Missing ${SINK_ENV}.`);
  }
  if (baseVersion === undefined || baseVersion.length === 0) {
    throw new Error(`Missing ${BASE_VERSION_ENV}.`);
  }
  return { sinkPath, baseVersion };
}

export function configurationProposalMcpServerSpec(
  settings: ConfigurationProposalChildSettings,
  cwd: string,
): Record<string, unknown> {
  return {
    type: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./configuration-proposal-main.js", import.meta.url))],
    cwd,
    env: {
      [SINK_ENV]: settings.sinkPath,
      [BASE_VERSION_ENV]: settings.baseVersion,
    },
  };
}

export function createConfigurationProposalServer(settings: ConfigurationProposalChildSettings): McpServer {
  const server = new McpServer({ name: "agent-configuration", version: "1.0.0" });
  let proposed = false;
  server.registerTool(
    CONFIGURATION_PROPOSAL_TOOL_NAME,
    {
      title: "Propose agent configuration",
      description:
        "Propose, but never apply, a small local agent configuration change. The host validates the candidate and asks the operator to approve it outside the model conversation. Never include credentials or secret values.",
      annotations: {
        // This call records an inert, session-scoped proposal only. It cannot
        // mutate the agent config or reach the network; the host owns the
        // separate validation and approval transaction. Marking that boundary
        // explicitly also prevents unattended MCP clients from inserting a
        // second, provider-owned approval prompt before our review card.
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: proposalInputSchema,
    },
    async (args) => {
      if (args.patch.length === 0 && args.role === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: "A configuration proposal must change config, the configured identity document's ## Role, or both." }],
        };
      }
      if (proposed) {
        return {
          isError: true,
          content: [{ type: "text", text: "Only one configuration proposal is accepted per turn." }],
        };
      }
      if (
        containsUnsafeConfigurationReviewControl(args.rationale)
        || (args.role !== undefined && containsUnsafeConfigurationReviewControl(args.role))
      ) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Configuration proposal review text may contain printable characters and LF newlines only; unsafe terminal or bidi controls were rejected.",
          }],
        };
      }
      if (
        args.patch.some((operation) =>
          secretBearingPointer(operation.path)
          || (operation.from !== undefined && secretBearingPointer(operation.from))
          || containsSecretLike(operation.value)
        )
        || containsSecretLike(args.rationale)
        || (args.role !== undefined && containsSecretLike(args.role))
      ) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Secret-bearing values and fields cannot enter a configuration proposal. Hand off to the masked mono-agent auth or owner-only .env flow.",
          }],
        };
      }
      proposed = true;
      const proposal: AgentConfigurationProposal = {
        schema: "mono-agent.configuration-proposal.v1",
        id: randomUUID(),
        baseVersion: settings.baseVersion,
        rationale: args.rationale,
        patch: args.patch as readonly JsonPatchOperation[],
        ...(args.role === undefined ? {} : { role: args.role }),
        createdAt: new Date().toISOString(),
      };
      await writeProposal(settings.sinkPath, proposal);
      return {
        content: [{
          type: "text",
          text: "Proposal recorded. Explain it briefly, but do not claim it was applied; the host will validate it and ask the operator separately.",
        }],
        structuredContent: { proposalId: proposal.id, status: "pending_host_validation" },
      };
    },
  );
  return server;
}

function secretBearingPointer(pointer: string): boolean {
  return pointer.slice(1).split("/").some((raw) => {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    return /(?:api.?key|credential|password|secret|token)/iu.test(segment) && !/(?:env|path)$/iu.test(segment);
  });
}

function containsSecretLike(value: unknown): boolean {
  if (typeof value === "string") {
    return /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+\S{12,}|\d{6,12}:[A-Za-z0-9_-]{20,})\b/u.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSecretLike);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, entry]) =>
      (/(?:api.?key|credential|password|secret|token)/iu.test(key) && !/(?:env|path)$/iu.test(key))
      || containsSecretLike(entry)
    );
  }
  return false;
}

async function writeProposal(path: string, proposal: AgentConfigurationProposal): Promise<void> {
  // The owner-local TUI pre-creates the capability directory. Never recreate
  // it here: removing that directory on console exit must revoke late tool
  // calls from an abort-ignoring provider rather than resurrect the session.
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(proposal)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
