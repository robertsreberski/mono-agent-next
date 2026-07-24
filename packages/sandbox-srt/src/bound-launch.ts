import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { SandboxSrtError } from "./errors.js";
import type { TrustedFile, TrustedFileBinding } from "./security.js";

export interface BoundLaunch {
  readonly command: string;
  readonly arguments: readonly string[];
}

const BOUND_EXECUTABLE_DESCRIPTOR = 3;
const BOUND_SETTINGS_DESCRIPTOR = 4;
const NODE_SRT_SHEBANG = "#!/usr/bin/env node";
const BOUND_NODE_SPECIFIER = "mono-agent-srt:bound-entry";
const UNBUNDLED_ENTRY_CODE = "ERR_MONO_AGENT_SRT_NOT_SELF_CONTAINED";
const resolveDependency = createRequire(import.meta.url).resolve;

export function boundLaunch(
  executable: TrustedFile,
  executableBinding: TrustedFileBinding,
  settingsBinding: TrustedFileBinding,
): BoundLaunch {
  if (
    executableBinding.descriptor < 0
    || settingsBinding.descriptor < 0
  ) {
    throw new SandboxSrtError(
      "sandbox_unavailable",
      "SRT descriptor binding is unavailable.",
    );
  }
  if (
    executableBinding.firstLine === NODE_SRT_SHEBANG
    && (process.platform === "linux" || process.platform === "darwin")
  ) {
    return boundNodeLaunch(
      executable,
      process.platform === "linux" ? "/proc/self/fd" : "/dev/fd",
    );
  }
  if (process.platform === "linux") {
    if (executableBinding.firstLine?.startsWith("#!") === true) {
      throw new SandboxSrtError(
        "sandbox_unavailable",
        "SRT descriptor-bound execution is unavailable for this executable.",
      );
    }
    return Object.freeze({
      command: `/proc/self/fd/${BOUND_EXECUTABLE_DESCRIPTOR}`,
      arguments: Object.freeze([
        "--settings",
        `/proc/self/fd/${BOUND_SETTINGS_DESCRIPTOR}`,
      ]),
    });
  }
  if (process.platform === "darwin") {
    throw new SandboxSrtError(
      "sandbox_unavailable",
      "SRT descriptor-bound execution is unavailable for this executable.",
    );
  }
  throw new SandboxSrtError(
    "sandbox_unavailable",
    "SRT descriptor-bound execution is unavailable on this platform.",
  );
}

export async function closeBindings(bindings: {
  readonly executable: TrustedFileBinding;
  readonly settings: TrustedFileBinding;
}): Promise<void> {
  await Promise.allSettled([
    bindings.executable.close(),
    bindings.settings.close(),
  ]);
}

function boundNodeLaunch(
  executable: TrustedFile,
  descriptorRoot: "/dev/fd" | "/proc/self/fd",
): BoundLaunch {
  const targetUrl = `${pathToFileURL(executable.path).href}?mono-agent-bound-entry`;
  const parserUrl = pathToFileURL(resolveDependency("acorn")).href;
  const loaderSource = [
    'import { readFile } from "node:fs/promises";',
    `import { parse } from ${JSON.stringify(parserUrl)};`,
    "function notSelfContained() {",
    'const error = new Error("The bound SRT entrypoint must be self-contained.");',
    `error.code = ${JSON.stringify(UNBUNDLED_ENTRY_CODE)};`,
    "return error;",
    "}",
    "function hasDynamicImport(root) {",
    "const pending = [root];",
    "const visited = new WeakSet();",
    "while (pending.length > 0) {",
    "const value = pending.pop();",
    'if (value === null || typeof value !== "object" || visited.has(value)) continue;',
    "visited.add(value);",
    'if (value.type === "ImportExpression") return true;',
    "for (const child of Object.values(value)) pending.push(child);",
    "}",
    "return false;",
    "}",
    "export async function resolve(specifier, context, nextResolve) {",
    `if (specifier === ${JSON.stringify(BOUND_NODE_SPECIFIER)}) {`,
    `return { url: ${JSON.stringify(targetUrl)}, shortCircuit: true };`,
    "}",
    `if (context.parentURL === ${JSON.stringify(targetUrl)} && !specifier.startsWith("node:")) {`,
    "throw notSelfContained();",
    "}",
    "return nextResolve(specifier, context);",
    "}",
    "export async function load(url, context, nextLoad) {",
    `if (url === ${JSON.stringify(targetUrl)}) {`,
    `const source = await readFile("${descriptorRoot}/${BOUND_EXECUTABLE_DESCRIPTOR}", "utf8");`,
    "let root;",
    "try {",
    'root = parse(source, { allowHashBang: true, ecmaVersion: "latest", sourceType: "module" });',
    "} catch {",
    "throw notSelfContained();",
    "}",
    "if (hasDynamicImport(root)) throw notSelfContained();",
    'return { format: "module", source, shortCircuit: true };',
    "}",
    "return nextLoad(url, context);",
    "}",
  ].join("\n");
  const loaderUrl = `data:text/javascript,${encodeURIComponent(loaderSource)}`;
  const registrationSource = [
    'import { register } from "node:module";',
    `register(${JSON.stringify(loaderUrl)}, import.meta.url);`,
  ].join("");
  const registrationUrl = `data:text/javascript,${encodeURIComponent(registrationSource)}`;
  const bootstrap = [
    `process.argv.splice(1, 0, ${JSON.stringify(executable.path)});`,
    "try {",
    `await import(${JSON.stringify(BOUND_NODE_SPECIFIER)});`,
    "} catch (error) {",
    `if (error?.code !== ${JSON.stringify(UNBUNDLED_ENTRY_CODE)}) throw error;`,
    'process.stderr.write("The bound SRT entrypoint is not self-contained.");',
    "process.exitCode = 126;",
    "}",
  ].join("");
  return Object.freeze({
    command: process.execPath,
    arguments: Object.freeze([
      "--disable-warning=DEP0205",
      "--import",
      registrationUrl,
      "--input-type=module",
      "--eval",
      bootstrap,
      "--",
      "--settings",
      `${descriptorRoot}/${BOUND_SETTINGS_DESCRIPTOR}`,
    ]),
  });
}
