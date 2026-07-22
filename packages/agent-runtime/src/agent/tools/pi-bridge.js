import { Type } from "@earendil-works/pi-ai";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { passthroughSandbox } from "../sandbox-seam.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  bashToolImpl,
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  normalizeBashTimeoutMs,
  readToolImpl,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "./index.js";
import {
  fileChangeSummary,
  readFileChangeSnapshot,
  statsForCompletedChange,
} from "../../ai/file-change-stats.js";
import { formatSkillBodyWithPathNote } from "../prompt/skill-index.js";
import { MAX_TOOL_RESULT_BYTES, summarisePayload, wrapToolsWithBloatGuard } from "../tool-bloat.js";
import { wrapToolsWithApprovalGate } from "../approval.js";
import { isInsidePath } from "./shared/path-resolver.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details,
  };
}

function imageResult(data, mimeType, details = {}) {
  return {
    content: [{ type: "image", data: String(data ?? ""), mimeType: mimeType || "image/png" }],
    details,
  };
}

function isImageToolResult(raw) {
  return Boolean(raw) && typeof raw === "object" && raw.kind === "image" && typeof raw.data === "string";
}

const MCP_TEXT_RESULT_LIMIT = 12_000;
// Fallback hard cap per MCP call when limits.mcpCallMaxTotalTimeoutMs is not
// provided; mirrors DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS in agent/compaction.js.
const DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS = 2_700_000;
const MCP_RAW_DETAIL_LIMIT = 4_000;
const MCP_IMAGE_INLINE_MAX_BYTES = 250_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function stripFrontmatter(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? content.slice(m[0].length).trim() : content.trim();
}

function isErrorText(value) {
  return /^Error:|^Exit code \d+:/i.test(String(value || "").trim());
}

function absolutizePath(value, cwd) {
  if (!value || typeof value !== "string" || isAbsolute(value) || !cwd) return value;
  return resolve(cwd, value);
}

const PLAYWRIGHT_FILENAME_TOOLS = new Set([
  "browser_console_messages",
  "browser_snapshot",
  "browser_take_screenshot",
]);

function artifactFilename(filename, outputDir) {
  if (!filename || typeof filename !== "string" || isAbsolute(filename) || !outputDir) return filename;
  const base = resolve(outputDir);
  const requested = resolve(base, filename);
  const target = isInsidePath(base, requested) ? requested : resolve(base, basename(filename));
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

/**
 * @param {any} _serverName
 * @param {any} toolName
 * @param {any} params
 * @param {{qaOutputDir?: any, ctx?: any}} [options]
 */
export function normalizeMcpToolParams(_serverName, toolName, params, { qaOutputDir, ctx } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  if (!PLAYWRIGHT_FILENAME_TOOLS.has(toolName) || !params.filename || isAbsolute(String(params.filename))) return params;
  const dir = qaOutputDir ?? (ctx ?? readToolRuntime()).qaOutputDir;
  return {
    ...params,
    filename: artifactFilename(params.filename, dir),
  };
}

function normalizeWorkdir(value, cwd, ctx) {
  const base = resolve(cwd || (ctx ?? readToolRuntime()).workspace || process.cwd());
  const resolved = value ? resolve(absolutizePath(value, base)) : base;
  return isInsidePath(base, resolved) ? resolved : base;
}

function withAbsolutePaths(name, params, cwd, ctx) {
  const next = { ...(params || {}) };
  if (["Read", "Write", "Edit"].includes(name)) next.file_path = absolutizePath(next.file_path, cwd);
  if (["Glob", "Grep"].includes(name)) next.path = absolutizePath(next.path, cwd);
  if (["Read", "Write", "Edit", "Glob", "Grep", "Bash"].includes(name)) {
    next.workdir = normalizeWorkdir(next.workdir, cwd, ctx);
  }
  return next;
}

function toolText(result) {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result); } catch { return String(result); }
}

function base64Bytes(data) {
  const text = String(data || "");
  if (!text) return 0;
  const clean = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
  return Math.floor(clean.length * 0.75);
}

function truncateMcpText(text, limit = MCP_TEXT_RESULT_LIMIT) {
  const value = String(text || "");
  if (value.length <= limit) return { text: value, truncated: false, originalLength: value.length };
  const marker = [
    "",
    `[truncated MCP tool result from ${value.length} to ${limit} characters]`,
    "Use a more specific MCP tool, filters, or a detail/get tool for the exact item you need.",
  ].join("\n");
  return {
    text: `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`,
    truncated: true,
    originalLength: value.length,
  };
}

function compactRawMcpResult(out) {
  let text;
  try {
    text = JSON.stringify(out || {});
  } catch {
    text = String(out ?? "");
  }
  if (text.length <= MCP_RAW_DETAIL_LIMIT) return out;
  return {
    truncated: true,
    original_length: text.length,
    preview: `${text.slice(0, MCP_RAW_DETAIL_LIMIT)}\n[truncated raw MCP result]`,
  };
}

function writeFileChangeDetails(path, before, after) {
  const change = {
    path,
    kind: before && before.exists ? "update" : "add",
  };
  const lineStats = statsForCompletedChange(change, before, after);
  const completedChange = lineStats ? { ...change, line_stats: lineStats } : change;
  const summary = fileChangeSummary([completedChange]);
  return {
    status: "completed",
    changes: [completedChange],
    ...(summary ? { summary } : {}),
  };
}

function limitedNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), fallback);
}

function withToolLimits(name, params, limits = {}) {
  const next = { ...(params || {}) };
  if (["Read", "Glob", "Grep", "WebFetch"].includes(name)) {
    next.max_output_chars = limitedNumber(next.max_output_chars, limits.toolTextLimitChars || 16000);
  }
  if (name === "Glob") {
    next.limit = limitedNumber(next.limit ?? next.max_matches, limits.searchResultLimit || 100);
    delete next.max_matches;
  }
  if (name === "Grep") {
    next.head_limit = limitedNumber(next.head_limit ?? next.max_matches, limits.searchResultLimit || 100);
    next.output_mode = next.output_mode || "files_with_matches";
    delete next.max_matches;
  }
  if (name === "Bash") {
    next.max_output_chars = limitedNumber(next.max_output_chars, limits.bashOutputLimitChars || limits.toolTextLimitChars || 20000);
    next.timeout = normalizeBashTimeoutMs(next.timeout, limits.bashTimeoutMs || DEFAULT_BASH_TIMEOUT_MS);
  }
  return next;
}

/**
 * @param {any} name
 * @param {any} params
 * @param {{cwd?: any, toolLimits?: any, ctx?: any}} [options]
 */
export function normalizePiBuiltinToolParams(name, params, { cwd, toolLimits, ctx } = {}) {
  return withToolLimits(name, withAbsolutePaths(name, params, cwd, ctx), toolLimits);
}

function integerSchema() {
  return { type: "integer" };
}

function isReadOnlyShellCommand(command) {
  const text = String(command || "").trim();
  if (!text) return false;
  if (/[;&|`<>]|\$\(/.test(text)) return false;
  return [
    /^pwd(\s|$)/,
    /^ls(\s|$)/,
    /^find(\s|$)/,
    /^rg(\s|$)/,
    /^grep(\s|$)/,
    /^sed(\s|$)/,
    /^awk(\s|$)/,
    /^cat(\s|$)/,
    /^head(\s|$)/,
    /^tail(\s|$)/,
    /^wc(\s|$)/,
    /^git\s+(status|diff|log|show|branch|rev-parse|ls-files)(\s|$)/,
  ].some((pattern) => pattern.test(text));
}

/**
 * @param {any} name
 * @param {any} label
 * @param {any} description
 * @param {any} parameters
 * @param {any} execute
 * @param {{cwd?: any, onEvent?: (event: any) => void, toolLimits?: any, toolPolicy?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any}} [options]
 */
function createBuiltinTool(name, label, description, parameters, execute, { cwd, onEvent, toolLimits, toolPolicy, sandboxPolicy, sandboxEngine, ctx } = {}) {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: name === "Write" || name === "Edit" || name === "Bash" || name === "NodeRepl" ? "sequential" : undefined,
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("tool execution aborted");
      const normalized = normalizePiBuiltinToolParams(name, params, { cwd, toolLimits, ctx });
      if (name === "Bash" && toolPolicy?.bashReadOnly && !isReadOnlyShellCommand(normalized.command)) {
        throw new Error("Error: Planning shell policy allows only read-only inspection commands.");
      }
      const shouldTrackWrite = name === "Write" && typeof normalized.file_path === "string" && normalized.file_path.length > 0;
      const beforeWrite = shouldTrackWrite ? readFileChangeSnapshot(normalized.file_path) : null;
      const raw = await execute(normalized, { signal, sandboxPolicy, sandboxEngine, ctx });
      // Image reads (e.g. Read on a .png) come back as a structured image
      // result so vision models see pixels; emit an image content block and let
      // the shared bloat guard cap oversize payloads.
      if (isImageToolResult(raw)) {
        return imageResult(raw.data, raw.mimeType, { tool: name, params: normalized });
      }
      const text = toolText(raw);
      if (isErrorText(text)) throw new Error(text);
      const details = { tool: name, params: normalized };
      if (shouldTrackWrite) {
        details.file_change = writeFileChangeDetails(normalized.file_path, beforeWrite, readFileChangeSnapshot(normalized.file_path));
      }
      return textResult(text, details);
    },
  };
}

/**
 * Progressive skill disclosure: exposes a `ReadSkill` tool so the agent can pull
 * a named skill's FULL body on demand (skills are otherwise injected index-only).
 *
 * Two input shapes are accepted, matching what hosts pass:
 *  - Minimal / legacy (mono-agent's agent-harness): bare `skillNames` + a shared
 *    `skillsRoot` (the directory that directly contains `<name>/SKILL.md`), or the
 *    back-compat `dataDir` (skills under `<dataDir>/skills`). This path is UNCHANGED.
 *  - pi's neutral `Skill` shape (`{name, description, content, filePath, ...}`,
 *    what worklab passes): each skill carries an absolute `filePath`. When NO shared
 *    `skillsRoot`/`dataDir` is configured, ReadSkill derives each skill's root from
 *    its own `filePath` — pi has no lazy-body equivalent, so the body is still read
 *    from disk on demand rather than injected up front.
 *
 * The path-traversal guard (resolved file must stay under the shared root) is
 * preserved on the shared-root path; on the filePath path the name→file binding is
 * fixed at build time and the model can only pick an enum value, so there is no
 * name-driven traversal surface.
 */
/**
 * @param {any[]} [skillNames]
 * @param {{skillsRoot?: any, dataDir?: any, skills?: any[]}} [options]
 */
function readSkillTool(skillNames = [], { skillsRoot, dataDir, skills = [] } = {}) {
  const sharedRoot = skillsRoot
    ? resolve(skillsRoot)
    : (dataDir ? resolve(dataDir, "skills") : null);
  const isSafeName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);

  // name -> {path, assetsPath, skillsRoot} derived from the pi Skill filePath.
  // filePath is the skill file itself (nested `<root>/<name>/SKILL.md` or a flat
  // `<root>/<name>.md`): assetsPath is its directory; the note-only skills root is
  // one level up for the nested layout, else the directory itself.
  const filePathEntries = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || typeof skill !== "object") continue;
    if (!isSafeName(skill.name) || typeof skill.filePath !== "string" || !skill.filePath) continue;
    if (filePathEntries.has(skill.name)) continue;
    const path = resolve(skill.filePath);
    const assetsPath = dirname(path);
    const root = basename(path) === "SKILL.md" ? dirname(assetsPath) : assetsPath;
    filePathEntries.set(skill.name, { path, assetsPath, skillsRoot: root });
  }

  // A shared root (minimal/legacy form) drives the tool exactly as before;
  // filePath is consulted ONLY when it is absent — "derive root from
  // skill.filePath when skillsRoot is absent".
  const enumNames = sharedRoot
    ? skillNames.filter(isSafeName)
    : [...filePathEntries.keys()];
  if (!enumNames.length) return null;

  return {
    name: "ReadSkill",
    label: "Read Skill",
    description: "Load the complete instructions for a named skill. Use ReadSkill instead of Read for SKILL.md files.",
    parameters: objectSchema({ name: { type: "string", enum: enumNames } }, ["name"]),
    async execute(_toolCallId, { name }) {
      if (sharedRoot) {
        const path = resolve(sharedRoot, name, "SKILL.md");
        if (!path.startsWith(sharedRoot + "/")) throw new Error(`invalid skill path: ${name}`);
        if (!existsSync(path)) throw new Error(`SKILL.md not found for ${name}`);
        return textResult(formatSkillBodyWithPathNote({
          body: stripFrontmatter(readFileSync(path, "utf8")),
          assetsPath: resolve(sharedRoot, name),
          skillsRoot: sharedRoot,
        }), { skill: name, path });
      }
      const entry = filePathEntries.get(name);
      if (!entry || !existsSync(entry.path)) throw new Error(`SKILL.md not found for ${name}`);
      return textResult(formatSkillBodyWithPathNote({
        body: stripFrontmatter(readFileSync(entry.path, "utf8")),
        assetsPath: entry.assetsPath,
        skillsRoot: entry.skillsRoot,
      }), { skill: name, path: entry.path });
    },
  };
}

export function createStructuredOutputTool(outputSchema, onStructuredOutput) {
  if (!outputSchema) return null;
  return {
    name: "StructuredOutput",
    label: "Structured Output",
    description: "Submit the final structured result object. Call this once when the response is complete.",
    parameters: Type.Unsafe(outputSchema),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      onStructuredOutput?.(params);
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
  };
}

/**
 * @param {any} allowedTools
 * @param {{disallowedTools?: any[], skillNames?: any[], skills?: any[], skillsRoot?: any, dataDir?: any, cwd?: any, onEvent?: (event: any) => void, toolLimits?: any, persistArtifact?: any, onTruncate?: any, toolPayloadMaxBytes?: number, imageInlineMaxBytes?: any, toolPolicy?: any, sandboxPolicy?: any, sandboxEngine?: any, approvalManager?: any, approvalModel?: any, nodeReplController?: any, ctx?: any}} [options]
 */
export function getPiBuiltinTools(allowedTools, {
  disallowedTools = [],
  skillNames = [],
  skills = [],
  skillsRoot,
  dataDir,
  cwd,
  onEvent,
  toolLimits,
  persistArtifact = null,
  onTruncate = null,
  toolPayloadMaxBytes = MAX_TOOL_RESULT_BYTES,
  imageInlineMaxBytes = toolPayloadMaxBytes,
  toolPolicy = null,
  sandboxPolicy = null,
  sandboxEngine = null,
  approvalManager = null,
  approvalModel = null,
  nodeReplController = null,
  ctx = null,
} = {}) {
  const textLimitSchema = integerSchema();
  const bashLimitSchema = integerSchema();
  const bashTimeoutSchema = {
    type: "integer",
    description: "Timeout in milliseconds. Use 30000 for 30 seconds; small values like 30 are treated as seconds for compatibility.",
  };
  // Per-tool closure config (cwd/event sink/limits/policy) plus the per-instance
  // ToolContext `ctx` that the tool impls and shared helpers read from.
  const toolContext = { cwd, onEvent, toolLimits, toolPolicy, sandboxPolicy, sandboxEngine, ctx };
  const all = {
    Read: createBuiltinTool("Read", "Read", "Read a local file. Text files return line-numbered content; image files (PNG, JPEG, GIF, WebP, BMP) are returned as a viewable image you can see directly — use this to look at image attachments.", objectSchema({
      file_path: { type: "string" },
      offset: { type: "integer" },
      start_line: { type: "integer" },
      limit: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["file_path"]), readToolImpl, toolContext),
    Write: createBuiltinTool("Write", "Write", "Write content to a local file.", objectSchema({
      file_path: { type: "string" },
      content: { type: "string" },
    }, ["file_path", "content"]), writeToolImpl, toolContext),
    Edit: createBuiltinTool("Edit", "Edit", "Replace an exact string in a local file.", objectSchema({
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    }, ["file_path", "old_string", "new_string"]), editToolImpl, toolContext),
    Glob: createBuiltinTool("Glob", "Glob", "Find files matching a pattern.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer" },
      offset: { type: "integer" },
      max_matches: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["pattern"]), globToolImpl, toolContext),
    Grep: createBuiltinTool("Grep", "Grep", "Search file contents with ripgrep. Defaults to returning matching file paths; use output_mode='content' only for exact snippets.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      type: { type: "string" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      context: { type: "integer" },
      case_insensitive: { type: "boolean" },
      multiline: { type: "boolean" },
      head_limit: { type: "integer" },
      offset: { type: "integer" },
      max_matches: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["pattern"]), grepToolImpl, toolContext),
    Bash: createBuiltinTool("Bash", "Bash", "Execute a shell command in the workspace.", objectSchema({
      command: { type: "string" },
      workdir: { type: "string" },
      description: { type: "string" },
      timeout: bashTimeoutSchema,
      max_output_chars: bashLimitSchema,
    }, ["command"]), bashToolImpl, toolContext),
    NodeRepl: nodeReplController
      ? createBuiltinTool(
        "NodeRepl",
        "Node REPL",
        "Evaluate JavaScript in a run-scoped Node.js REPL. Variables persist across NodeRepl calls in this run.",
        objectSchema({ code: { type: "string", minLength: 1 } }, ["code"]),
        (params, { signal }) => nodeReplController.execute(params, { signal }),
        toolContext,
      )
      : null,
    WebFetch: createBuiltinTool("WebFetch", "Web Fetch", "Fetch a URL and return text.", objectSchema({
      url: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      max_output_chars: textLimitSchema,
    }, ["url"]), webFetchToolImpl, toolContext),
    WebSearch: createBuiltinTool("WebSearch", "Web Search", "Search the web and return result summaries.", objectSchema({
      query: { type: "string" },
      limit: { type: "integer" },
    }, ["query"]), webSearchToolImpl, toolContext),
  };
  // allowedTools honors the `"*"` allow-all sentinel (and undefined) as "every
  // built-in"; disallowedTools is the deny-wins filter applied to the final set.
  const allowAll = !Array.isArray(allowedTools) || allowedTools.includes("*");
  const selected = allowAll ? Object.keys(all) : allowedTools;
  const denied = new Set(Array.isArray(disallowedTools) ? disallowedTools : []);
  const names = selected.filter((name) => !denied.has(name));
  const tools = names.map((name) => all[name]).filter(Boolean);
  const skillTool = readSkillTool(skillNames, { skillsRoot, dataDir, skills });
  // Deny-check the canonical PascalCase name AND the legacy snake_case alias so
  // an old denylist keeps disabling the tool after the rename.
  if (skillTool && !denied.has("ReadSkill") && !denied.has("read_skill" /* legacy alias */)) tools.push(skillTool);
  const gated = approvalManager
    ? wrapToolsWithApprovalGate(tools, approvalManager, { model: approvalModel })
    : tools;
  return wrapToolsWithBloatGuard(gated, {
    persistArtifact,
    maxBytes: toolPayloadMaxBytes,
    imageMaxBytes: imageInlineMaxBytes,
    onTruncate,
  });
}

export function resolveMcpStdioCwd(cfg = {}, cwd = null) {
  const configured = cfg.cwd || null;
  if (configured && isAbsolute(configured)) return configured;
  if (configured) return resolve(cwd || process.cwd(), configured);
  return cwd || process.cwd();
}

export async function prepareMcpStdioCommand(cfg = {}, { cwd = null, sandboxPolicy = null, sandboxEngine = null, ctx = null } = {}) {
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const appOwnedLocalBinding = cfg[Symbol.for("@mono-agent/app-owned-local-binding")] === true;
  return sandbox.prepareCommand({
    policy: resolveSandboxPolicy(resolvedCtx, sandboxPolicy),
    engine: sandboxEngine ?? undefined,
    command: {
      command: cfg.command,
      args: cfg.args || [],
      cwd: resolveMcpStdioCwd(cfg, cwd),
      ...(cfg.env && typeof cfg.env === "object" ? { env: cfg.env } : {}),
      ...(appOwnedLocalBinding ? { allowLocalBinding: true } : {}),
    },
  });
}

/**
 * @param {any} name
 * @param {any} cfg
 * @param {{cwd?: any, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any}} [options]
 */
async function connectMcpClient(name, cfg, { cwd, sandboxPolicy, sandboxEngine, ctx } = {}) {
  const brand = (ctx ?? readToolRuntime()).runtimeBrand;
  const client = new McpClient(
    { name: `${brand.mcpClientName}/${name}`, version: brand.mcpClientVersion },
    { capabilities: {} },
  );
  let transport;
  if (cfg.type === "http") {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers || {} } });
  } else if (cfg.type === "sse") {
    transport = new SSEClientTransport(new URL(cfg.url), {
      // SSE EventSourceInit's typed shape omits `headers`, but the transport
      // forwards them to the underlying EventSource — keep the header pass-through.
      eventSourceInit: /** @type {any} */ ({ headers: cfg.headers || {} }),
      requestInit: { headers: cfg.headers || {} },
    });
  } else {
    const prepared = await prepareMcpStdioCommand(cfg, { cwd, sandboxPolicy, sandboxEngine, ctx });
    transport = new StdioClientTransport({
      command: prepared.command,
      args: prepared.args || [],
      cwd: prepared.cwd,
      env: { ...process.env, ...(prepared.env || {}) },
    });
    // Monkey-patched cleanup handle: not part of the MCP transport's typed shape.
    /** @type {any} */ (transport).__monoSandboxCleanup = prepared.cleanup;
  }
  try {
    await client.connect(transport);
    return { name, client, transport };
  } catch (error) {
    try { await transport?.close?.(); } catch { /* best-effort */ }
    try { await /** @type {any} */ (transport)?.__monoSandboxCleanup?.(); } catch { /* best-effort */ }
    throw error;
  }
}

export function coerceMcpContent(out, {
  textLimit = MCP_TEXT_RESULT_LIMIT,
  imageInlineMaxBytes = MCP_IMAGE_INLINE_MAX_BYTES,
  persistArtifact = null,
  toolName = "mcp",
  toolUseId = null,
  onTruncate = null,
} = {}) {
  if (Array.isArray(out?.content) && out.content.length) {
    return out.content.map((part) => {
      if (part.type === "text") return { type: "text", text: truncateMcpText(part.text || "", textLimit).text };
      if (part.type === "image") {
        const bytes = base64Bytes(part.data);
        if (bytes > imageInlineMaxBytes) {
          const summary = summarisePayload(toolName, [{
            type: "image",
            data: part.data,
            mimeType: part.mimeType || part.mime_type || "image/png",
          }], persistArtifact, { maxBytes: imageInlineMaxBytes, toolUseId });
          if (summary.truncated && typeof onTruncate === "function") {
            try {
              onTruncate({
                tool: toolName,
                tool_use_id: toolUseId,
                original_bytes: summary.originalBytes,
                max_bytes: imageInlineMaxBytes,
                saved_paths: summary.savedPaths,
              });
            } catch { /* best-effort */ }
          }
          return summary.rewrittenBlocks[0] || {
            type: "text",
            text: `[omitted MCP image result: ${bytes} bytes exceeds ${imageInlineMaxBytes} byte context budget]`,
          };
        }
        return {
          type: "image",
          data: part.data,
          mimeType: part.mimeType || part.mime_type || "image/png",
        };
      }
      return { type: "text", text: truncateMcpText(JSON.stringify(part), textLimit).text };
    });
  }
  return [{ type: "text", text: truncateMcpText(JSON.stringify(out || {}), textLimit).text }];
}

function mcpContentWasTruncated(out, { textLimit = MCP_TEXT_RESULT_LIMIT, imageInlineMaxBytes = MCP_IMAGE_INLINE_MAX_BYTES } = {}) {
  if (Array.isArray(out?.content) && out.content.length) {
    return out.content.some((part) => {
      if (part.type === "text") return truncateMcpText(part.text || "", textLimit).truncated;
      if (part.type === "image") return base64Bytes(part.data) > imageInlineMaxBytes;
      return truncateMcpText(JSON.stringify(part), textLimit).truncated;
    });
  }
  return truncateMcpText(JSON.stringify(out || {}), textLimit).truncated;
}

function mcpToolName(serverName, toolName, reservedNames) {
  if (!reservedNames.has(toolName)) return toolName;
  return `mcp__${serverName}__${toolName}`;
}

// Inactivity wall clock around an MCP call. `registerReset` (optional) hands the
// caller a rearm function so tool progress notifications can keep a legitimately
// long call alive; the SDK's maxTotalTimeout stays the hard cap.
function withTimeout(promise, timeoutMs, signal, label, registerReset) {
  if (signal?.aborted) return Promise.reject(new Error("tool execution aborted"));
  const ms = Number(timeoutMs) || 120000;
  let timeout;
  const timer = new Promise((_, reject) => {
    const arm = () => setTimeout(() => reject(new Error(`${label || "MCP tool"} timed out after ${ms}ms`)), ms);
    timeout = arm();
    registerReset?.(() => {
      clearTimeout(timeout);
      timeout = arm();
    });
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

/**
 * @param {any} mcpConfig
 * @param {Set<any>} [reservedNames]
 * @param {{limits?: any, cwd?: any, persistArtifact?: any, qaOutputDir?: any, onTruncate?: any, toolPayloadMaxBytes?: number, sandboxPolicy?: any, sandboxEngine?: any, onToolProgress?: any, ctx?: any}} [options]
 */
export async function initPiMcpTools(mcpConfig, reservedNames = new Set(), {
  limits = {},
  cwd = null,
  persistArtifact = null,
  qaOutputDir = null,
  onTruncate = null,
  toolPayloadMaxBytes = MAX_TOOL_RESULT_BYTES,
  sandboxPolicy = null,
  sandboxEngine = null,
  onToolProgress = null,
  ctx = null,
} = {}) {
  const clients = [];
  const tools = [];
  const entries = Object.entries(mcpConfig || {});
  const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectMcpClient(name, cfg, { cwd, sandboxPolicy, sandboxEngine, ctx })));
  const warnings = [];
  const seen = new Set(reservedNames);

  // Phase 1: collect connected clients in entry order (so tool registration is
  // deterministic) and record connect failures.
  const connectedList = [];
  for (const [index, result] of settled.entries()) {
    const serverName = entries[index]?.[0];
    if (result.status !== "fulfilled") {
      warnings.push({
        type: "runtime_warning",
        warning_kind: "mcp_init_failed",
        server: serverName,
        message: result.reason?.message || String(result.reason),
      });
      continue;
    }
    clients.push(result.value);
    connectedList.push({ serverName, connected: result.value });
  }

  // Phase 2: list tools from every connected server CONCURRENTLY (previously
  // serial, adding ~Nx the slowest listTools to turn startup, painful over a
  // SOCKS proxy). Results are awaited in entry order to keep registration stable.
  const listings = await Promise.all(connectedList.map(async ({ serverName, connected }) => {
    try {
      return { serverName, connected, listed: await connected.client.listTools() };
    } catch (err) {
      return { serverName, connected, error: err };
    }
  }));

  for (const { serverName, connected, listed, error } of listings) {
    if (error) {
      warnings.push({
        type: "runtime_warning",
        warning_kind: "mcp_list_tools_failed",
        server: serverName,
        message: error?.message || String(error),
      });
      continue;
    }

    for (const sourceTool of listed.tools || []) {
      const name = mcpToolName(serverName, sourceTool.name, seen);
      if (seen.has(name)) continue;
      seen.add(name);
      tools.push({
        name,
        label: sourceTool.title || sourceTool.name,
        description: sourceTool.description || `${serverName}:${sourceTool.name}`,
        parameters: sourceTool.inputSchema || /** @type {any} */ (sourceTool).input_schema || objectSchema({}),
        async execute(toolCallId, params, signal) {
          if (signal?.aborted) throw new Error("tool execution aborted");
          const textLimit = limits.mcpTextLimitChars || MCP_TEXT_RESULT_LIMIT;
          const imageInlineMaxBytes = limits.imageInlineMaxBytes ?? MCP_IMAGE_INLINE_MAX_BYTES;
          const normalizedParams = normalizeMcpToolParams(serverName, sourceTool.name, params || {}, { qaOutputDir, ctx });
          // Measure the MCP round-trip so observability can separate slow MCP
          // servers (e.g. context-example over a SOCKS proxy) from model latency.
          const mcpCallStartMs = Date.now();
          // The MCP SDK's per-request timeout defaults to 60s (DEFAULT_REQUEST_TIMEOUT_MSEC),
          // which would fire -32001 well before the outer withTimeout wall-clock cap — fatal for
          // in-process tools that run a whole agent turn (e.g. notify_conversation delivery).
          // Pass it explicitly so the SDK request timeout matches our cap instead of pre-empting it.
          const mcpCallTimeoutMs = limits.mcpCallTimeoutMs || 120000;
          // Inactivity vs total: mcpCallTimeoutMs is reset by every progress
          // notification (keep-alive for long tools like transcription or an
          // ask-the-user wait); mcpCallMaxTotalTimeoutMs is the unresettable cap.
          const mcpCallMaxTotalTimeoutMs = Math.max(
            limits.mcpCallMaxTotalTimeoutMs || DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS,
            mcpCallTimeoutMs,
          );
          // The SDK only attaches a progressToken (and thus honors
          // resetTimeoutOnProgress) when an onprogress callback is present, so one
          // is always attached: it rearms the outer wall clock and optionally
          // surfaces the notification to the host.
          let resetInactivityTimeout = null;
          const onprogress = (progress) => {
            resetInactivityTimeout?.();
            onToolProgress?.({
              type: "tool_progress",
              server: serverName,
              tool: sourceTool.name,
              toolCallId,
              ...(progress?.progress === undefined ? {} : { progress: progress.progress }),
              ...(progress?.total === undefined ? {} : { total: progress.total }),
              ...(progress?.message === undefined ? {} : { message: progress.message }),
            });
          };
          const out = await withTimeout(
            connected.client.callTool(
              { name: sourceTool.name, arguments: normalizedParams || {} },
              undefined,
              // Forward the abort signal too, so a cancelled/timed-out call also cancels the
              // in-flight MCP request on the wire (otherwise the SDK keeps awaiting until its own
              // timeout, and an in-process loopback turn could post late after the bridge rejected).
              {
                timeout: mcpCallTimeoutMs,
                resetTimeoutOnProgress: true,
                maxTotalTimeout: mcpCallMaxTotalTimeoutMs,
                signal,
                onprogress,
              },
            ),
            mcpCallTimeoutMs,
            signal,
            `${serverName}:${sourceTool.name}`,
            (reset) => {
              resetInactivityTimeout = reset;
            },
          );
          const mcpCallDurationMs = Date.now() - mcpCallStartMs;
          const imageTruncations = [];
          return {
            content: coerceMcpContent(out, {
              textLimit,
              imageInlineMaxBytes,
              persistArtifact,
              toolName: name,
              toolUseId: toolCallId,
              onTruncate: (event) => {
                imageTruncations.push(event);
                onTruncate?.(event);
              },
            }),
            details: {
              server: serverName,
              tool: sourceTool.name,
              // pi-agent-core treats a resolved execute() call as successful.
              // Preserve the MCP protocol's explicit error bit in details so
              // the harness after-tool hook can replace that default without
              // throwing away the bounded content or structuredContent below.
              ...(out?.isError === true ? { mcp_result_is_error: true } : {}),
              mcp_call_duration_ms: mcpCallDurationMs,
              result_truncated: mcpContentWasTruncated(out, { textLimit, imageInlineMaxBytes }),
              raw: compactRawMcpResult(out),
              ...(imageTruncations.length ? {
                tool_payload_truncated: true,
                tool_payload_original_bytes: imageTruncations.reduce((sum, event) => sum + (Number(event.original_bytes) || 0), 0),
                tool_payload_saved_paths: imageTruncations.flatMap((event) => event.saved_paths || []),
              } : {}),
            },
          };
        },
      });
    }
  }
  return {
    clients,
    tools: wrapToolsWithBloatGuard(tools, {
      persistArtifact,
      maxBytes: toolPayloadMaxBytes,
      onTruncate,
    }),
    warnings,
  };
}

async function closeWithTimeout(close, timeoutMs) {
  if (typeof close !== "function") return;
  const result = close();
  if (!(result && typeof result.then === "function")) return;
  let timer;
  try {
    await Promise.race([
      result,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closePiMcpClients(clients, { timeoutMs = 5000 } = {}) {
  // Close the client first (stop accepting messages) then the transport (tear
  // down I/O), each bounded by a timeout so a hung stdio pipe cannot stall
  // shutdown — a common source of "Connection closed" churn on reconnect.
  await Promise.all((clients || []).map(async ({ client, transport }) => {
    try { await closeWithTimeout(client?.close?.bind(client), timeoutMs); } catch { /* best-effort */ }
    try { await closeWithTimeout(transport?.close?.bind(transport), timeoutMs); } catch { /* best-effort */ }
    try { await transport?.__monoSandboxCleanup?.(); } catch { /* best-effort */ }
  }));
}
