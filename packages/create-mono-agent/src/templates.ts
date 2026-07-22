export interface MinimalProjectOptions {
  projectName: string;
  displayName?: string;
}

export interface RenderedProjectFile {
  path: string;
  contents: string;
  mode: number;
}

const DEFAULT_VERSION = "0.15.0";

export function renderMinimalProject(options: MinimalProjectOptions): readonly RenderedProjectFile[] {
  if (options.projectName.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(options.projectName)) {
    throw new TypeError(`Invalid npm package name: ${JSON.stringify(options.projectName)}`);
  }
  const agentId = agentIdFor(options.projectName);
  const displayName = options.displayName ?? titleCase(agentId);
  if (displayName.trim().length === 0) throw new TypeError("displayName must be non-empty");
  const config = minimalConfig(agentId, displayName);
  const schema = minimalSchema();

  return [
    {
      path: ".env.example",
      contents: "WEBHOOK_API_KEY=\n",
      mode: 0o600,
    },
    {
      path: ".gitignore",
      contents: [".env", ".secrets/", ".mono-agent/sessions/", "node_modules/", ""].join("\n"),
      mode: 0o644,
    },
    {
      path: ".mono-agent/mono-agent.config.schema.json",
      contents: `${JSON.stringify(schema, null, 2)}\n`,
      mode: 0o644,
    },
    {
      path: "AGENTS.md",
      contents: [
        "# Agent instructions",
        "",
        `You are ${displayName}, a focused and reliable assistant.`,
        "",
        "- Work only within the configured workspace.",
        "- Ask before taking an action that could destroy or disclose user data.",
        "- Report runtime and tool failures honestly; never invent successful results.",
        "",
      ].join("\n"),
      mode: 0o644,
    },
    {
      path: "README.md",
      contents: projectReadme(displayName),
      mode: 0o644,
    },
    {
      path: "mono-agent.config.json",
      contents: `${JSON.stringify(config, null, 2)}\n`,
      mode: 0o644,
    },
    {
      path: "package.json",
      contents: `${JSON.stringify(projectManifest(options.projectName, DEFAULT_VERSION), null, 2)}\n`,
      mode: 0o644,
    },
  ];
}

function projectReadme(displayName: string): string {
  return [
    `# ${displayName}`,
    "",
    "## Configure credentials",
    "",
    "Create `.secrets/pi/auth.json` as an owner-private file. It is ignored by Git.",
    "Use this shape for the default OpenAI route, replacing the placeholder locally:",
    "",
    "```json",
    "{",
    '  "openai": { "type": "api_key", "key": "<OPENAI_API_KEY>" }',
    "}",
    "```",
    "",
    "Then run `chmod 600 .secrets/pi/auth.json` and export a strong",
    "`WEBHOOK_API_KEY` for the loopback webhook.",
    "",
    "## Run",
    "",
    "```bash",
    "pnpm install",
    "pnpm run validate",
    "pnpm start",
    "```",
    "",
  ].join("\n");
}

function projectManifest(projectName: string, version: string): Record<string, unknown> {
  return {
    name: projectName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      validate: "mono-agent validate --config ./mono-agent.config.json",
      schema: "mono-agent config schema --config ./mono-agent.config.json --write",
      start: "mono-agent start --config ./mono-agent.config.json",
    },
    dependencies: {
      "@mono-agent/module-sdk": version,
      "@mono-agent/core": version,
      "@mono-agent/cli": version,
      "@mono-agent/runtime-pi": version,
      "@mono-agent/channel-webhook": version,
    },
  };
}

function minimalConfig(projectName: string, displayName: string): Record<string, unknown> {
  return {
    $schema: "./.mono-agent/mono-agent.config.schema.json",
    configVersion: 1,
    agent: {
      id: projectName,
      name: displayName,
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: {
      pi: {
        $use: "@mono-agent/runtime-pi",
        auth: {
          path: "./.secrets/pi/auth.json",
        },
      },
    },
    routing: {
      primary: {
        runtime: "pi",
        model: "openai:gpt-5.6-sol",
      },
      fallbacks: [],
      effort: "high",
    },
    session: {
      mode: "continuous",
    },
    channels: {
      inbound: {
        $use: "@mono-agent/channel-webhook",
        listen: {
          host: "127.0.0.1",
          port: 3210,
        },
        apiKey: {
          $env: "WEBHOOK_API_KEY",
        },
      },
    },
    policy: {
      tools: {
        default: "deny",
        allow: [],
      },
      approvals: {
        default: "allow",
      },
      sandbox: {
        mode: "off",
      },
    },
  };
}

function minimalSchema(): Record<string, unknown> {
  const routeSchema = {
    type: "object",
    additionalProperties: false,
    required: ["runtime", "model"],
    properties: {
      runtime: { const: "pi" },
      model: { type: "string", pattern: "^[^:]+:.+$" },
    },
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://mono-agent.dev/schemas/0.15.0/minimal-agent-config.json",
    title: "Minimal mono-agent configuration",
    type: "object",
    additionalProperties: false,
    required: [
      "$schema",
      "configVersion",
      "agent",
      "runtimes",
      "routing",
      "session",
      "channels",
      "policy",
    ],
    properties: {
      $schema: { type: "string", const: "./.mono-agent/mono-agent.config.schema.json" },
      configVersion: { const: 1 },
      agent: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "instructions", "workspace"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          instructions: { type: "string", minLength: 1 },
          workspace: { type: "string", minLength: 1 },
        },
      },
      runtimes: {
        type: "object",
        additionalProperties: false,
        required: ["pi"],
        properties: {
          pi: {
            type: "object",
            additionalProperties: false,
            required: ["$use", "auth"],
            properties: {
              $use: { const: "@mono-agent/runtime-pi" },
              auth: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: {
                  path: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
      routing: {
        type: "object",
        additionalProperties: false,
        required: ["primary", "fallbacks", "effort"],
        properties: {
          primary: routeSchema,
          fallbacks: { type: "array", items: routeSchema },
          effort: { enum: ["minimal", "low", "medium", "high", "xhigh"] },
        },
      },
      session: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: {
          mode: { const: "continuous" },
        },
      },
      channels: {
        type: "object",
        additionalProperties: false,
        required: ["inbound"],
        properties: {
          inbound: {
            type: "object",
            additionalProperties: false,
            required: ["$use", "listen", "apiKey"],
            properties: {
              $use: { const: "@mono-agent/channel-webhook" },
              listen: {
                type: "object",
                additionalProperties: false,
                required: ["host", "port"],
                properties: {
                  host: { type: "string", minLength: 1 },
                  port: { type: "integer", minimum: 0, maximum: 65535 },
                },
              },
              apiKey: { $ref: "#/$defs/envReference" },
            },
          },
        },
      },
      policy: {
        type: "object",
        additionalProperties: false,
        required: ["tools", "approvals", "sandbox"],
        properties: {
          tools: {
            type: "object",
            additionalProperties: false,
            required: ["default", "allow"],
            properties: {
              default: { enum: ["allow", "deny"] },
              allow: { type: "array", items: { type: "string" }, uniqueItems: true },
            },
          },
          approvals: {
            type: "object",
            additionalProperties: false,
            required: ["default"],
            properties: {
              default: { enum: ["ask", "allow", "deny"] },
            },
          },
          sandbox: {
            type: "object",
            additionalProperties: false,
            required: ["mode"],
            properties: {
              mode: { const: "off" },
            },
          },
        },
      },
    },
    $defs: {
      envReference: {
        type: "object",
        additionalProperties: false,
        required: ["$env"],
        properties: {
          $env: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
        },
      },
    },
  };
}

function titleCase(value: string): string {
  return value
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function agentIdFor(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/^@/u, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
}
