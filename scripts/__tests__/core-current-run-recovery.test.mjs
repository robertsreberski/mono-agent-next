// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceModulePath = join(
  repositoryRoot,
  "packages",
  "core",
  "dist",
  "current-run-workspace.js",
);
const temporaryDirectories = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Core current-run crash recovery", () => {
  it.skipIf(!["darwin", "linux"].includes(process.platform))(
    "releases the process lease on SIGKILL and recovers verified residue",
    async () => {
      expect(existsSync(workspaceModulePath)).toBe(true);
      const projectRoot = mkdtempSync(join(tmpdir(), "mono-agent-core-recovery-"));
      temporaryDirectories.push(projectRoot);
      const moduleUrl = pathToFileURL(workspaceModulePath).href;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", childSource(), moduleUrl, projectRoot],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const ready = await childReady(child);
      expect(ready.runRoot).toBe(join(
        projectRoot,
        ".mono-agent",
        "data",
        "core",
        "mcp-runs",
        "run-killed",
      ));
      expect(existsSync(join(ready.runRoot, "outbound", "result.txt"))).toBe(true);
      const { openCurrentRunWorkspace } = await import(moduleUrl);
      await expect(openCurrentRunWorkspace({ projectRoot })).rejects.toMatchObject({
        name: "CurrentRunWorkspaceError",
        code: "busy",
      });

      const exited = childExit(child);
      expect(child.kill("SIGKILL")).toBe(true);
      const result = await exited;
      expect(result.signal).toBe("SIGKILL");
      expect(existsSync(ready.runRoot)).toBe(true);

      const recovered = await openCurrentRunWorkspace({ projectRoot });
      expect(existsSync(ready.runRoot)).toBe(false);
      const next = await recovered.createRunFiles({
        runId: "run-after-crash",
        conversationId: "integration",
        attachments: [],
        signal: new AbortController().signal,
      });
      writeFileSync(join(next.runOutputDir, "proof.txt"), "recovered");
      await next.cleanup();
      await recovered.close();

      expect(readdirSync(join(
        projectRoot,
        ".mono-agent",
        "data",
        "core",
        "mcp-runs",
      ))).toEqual([]);
    },
    20_000,
  );
});

function childSource() {
  return `
import { writeFile } from "node:fs/promises";
const moduleUrl = process.argv[1];
const projectRoot = process.argv[2];
const { openCurrentRunWorkspace } = await import(moduleUrl);
const workspace = await openCurrentRunWorkspace({ projectRoot });
const files = await workspace.createRunFiles({
  runId: "run-killed",
  conversationId: "integration",
  attachments: [],
  signal: new AbortController().signal,
});
await writeFile(new URL("file://" + files.runOutputDir + "/result.txt"), "sensitive");
process.stdout.write(JSON.stringify({
  runRoot: files.runOutputDir.slice(0, -"/outbound".length),
}) + "\\n");
setInterval(() => {}, 1_000);
`;
}

function childReady(child) {
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectReady(new Error(`child did not become ready: ${stderr}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `child exited before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
      ));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(stdout.slice(0, newline)));
    });
  });
}

function childExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}
