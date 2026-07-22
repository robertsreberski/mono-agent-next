import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const {
  buildGeneratedConfigReferenceMarkdown,
  buildMonoAgentConfigSchema,
} = await import("../packages/agent-app/dist/config-reference.js");

const schemaPath = join(root, "packages/agent-app/schema/mono-agent.config.schema.json");
const referencePath = join(root, "docs/config/reference.md");

await mkdir(dirname(schemaPath), { recursive: true });
await mkdir(dirname(referencePath), { recursive: true });

await writeFile(schemaPath, `${JSON.stringify(buildMonoAgentConfigSchema(), null, 2)}\n`);
await writeFile(referencePath, buildGeneratedConfigReferenceMarkdown());
