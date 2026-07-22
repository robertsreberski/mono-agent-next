import { query } from "@anthropic-ai/claude-agent-sdk";
import { normalizeClaudeSdkCatalog } from "./claude-sdk-discovery.js";

const abortController = new AbortController();
let activeQuery = null;

async function* emptyInput() {
  // Initialization is the operation. An empty async input keeps the SDK from
  // executing a paid model turn while still opening the control channel.
}

function abort() {
  abortController.abort();
  try { activeQuery?.close?.(); } catch { /* best effort */ }
}

process.on("message", (message) => {
  if (message && typeof message === "object" && /** @type {any} */ (message).type === "abort") abort();
});

async function main() {
  try {
    activeQuery = query({
      prompt: emptyInput(),
      options: /** @type {any} */ ({
        cwd: process.cwd(),
        abortController,
        persistSession: false,
        settingSources: [],
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        env: {
          ...process.env,
          MCP_CONNECTION_NONBLOCKING: "0",
        },
      }),
    });
    const initialization = await activeQuery.initializationResult();
    const models = normalizeClaudeSdkCatalog(initialization?.models, "discovered");
    process.send?.({ type: "claude_catalog", models });
  } catch {
    // Raw SDK errors may contain paths or account detail. The parent needs
    // only a typed failure signal so it can use the curated cache.
    process.send?.({ type: "claude_catalog_error" });
    process.exitCode = 1;
  } finally {
    try { activeQuery?.close?.(); } catch { /* best effort */ }
    try { process.disconnect?.(); } catch { /* best effort */ }
  }
}

void main();
