// SPDX-License-Identifier: MIT
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

const DOCS_MCP_PACKAGE = "@mono-agent/docs-mcp";
const DOCS_MCP_BIN = "mono-agent-docs-mcp";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CLI_BYTES = 4 * 1024 * 1024;

function isWithin(root, path) {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

async function readManifest(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} manifest must be a bounded regular file.`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} manifest is not valid JSON.`, {
      cause: error,
    });
  }
}

export async function resolvePreinstalledDocsMcp({
  expectedVersion,
  installRoot,
  platform = process.platform,
}) {
  if (typeof installRoot !== "string" || !isAbsolute(installRoot)) {
    throw new Error("MONO_AGENT_DOCS_MCP_INSTALL_ROOT must be an absolute path.");
  }
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    throw new Error("Expected docs-mcp version must be a non-empty string.");
  }
  const requestedRoot = resolve(installRoot);
  const rootMetadata = await lstat(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("MONO_AGENT_DOCS_MCP_INSTALL_ROOT must be a real directory.");
  }
  const root = await realpath(requestedRoot);
  if (root === parse(root).root) {
    throw new Error("MONO_AGENT_DOCS_MCP_INSTALL_ROOT must not be a filesystem root.");
  }

  const manifestPath = join(
    root,
    "node_modules",
    "@mono-agent",
    "docs-mcp",
    "package.json",
  );
  const canonicalManifestPath = await realpath(manifestPath);
  if (!isWithin(root, canonicalManifestPath)) {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} manifest escapes the install root.`);
  }
  const manifest = await readManifest(canonicalManifestPath);
  if (manifest.name !== DOCS_MCP_PACKAGE || manifest.version !== expectedVersion) {
    throw new Error(
      `Installed ${DOCS_MCP_PACKAGE} identity/version mismatch: expected `
      + `${DOCS_MCP_PACKAGE}@${expectedVersion}.`,
    );
  }
  if (manifest.bin?.[DOCS_MCP_BIN] !== "./dist/cli.js") {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} bin contract mismatch.`);
  }
  const packageRoot = dirname(canonicalManifestPath);
  const cli = await realpath(join(packageRoot, "dist", "cli.js"));
  if (!isWithin(packageRoot, cli)) {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} CLI escapes the package root.`);
  }
  const cliMetadata = await lstat(cli);
  if (!cliMetadata.isFile() || cliMetadata.size > MAX_CLI_BYTES) {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} CLI must be a bounded regular file.`);
  }

  const executable = join(
    root,
    "node_modules",
    ".bin",
    platform === "win32" ? `${DOCS_MCP_BIN}.cmd` : DOCS_MCP_BIN,
  );
  const executableMetadata = await lstat(executable);
  if (!executableMetadata.isFile() && !executableMetadata.isSymbolicLink()) {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} executable is not a file.`);
  }
  const canonicalExecutable = await realpath(executable);
  if (!isWithin(root, canonicalExecutable)) {
    throw new Error(`Installed ${DOCS_MCP_PACKAGE} executable escapes the install root.`);
  }
  return {
    cli,
    executable,
    installRoot: root,
    package: DOCS_MCP_PACKAGE,
    version: expectedVersion,
  };
}
