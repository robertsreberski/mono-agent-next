import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  renderOssHygieneReport,
  runCheckOssHygiene,
  scanOssHygieneRecords,
} from "../check-oss-hygiene.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-oss-hygiene", () => {
  it("reports non-synthetic consumer fixture names without printing the raw name", () => {
    const records = [
      {
        path: "packages/agent-app/src/__tests__/fixtures/consumers/legacy-agent/mono-agent.config.json",
        text: "projectName: legacy-agent\n",
      },
    ];

    const findings = scanOssHygieneRecords(records);

    expect(findings).toEqual([
      {
        column: 1,
        file: "packages/agent-app/src/__tests__/fixtures/consumers/[non-synthetic-consumer]/mono-agent.config.json",
        label: "non-synthetic-consumer-fixture-name",
        line: 0,
      },
      {
        column: 14,
        file: "packages/agent-app/src/__tests__/fixtures/consumers/[non-synthetic-consumer]/mono-agent.config.json",
        label: "non-synthetic-consumer-fixture-reference",
        line: 1,
      },
    ]);

    const report = renderOssHygieneReport(findings);
    expect(report).toContain("non-synthetic-consumer-fixture-name");
    expect(report).toContain("non-synthetic-consumer-fixture-reference");
    expect(report).not.toContain("legacy-agent");
  });

  it("flags real-looking home directories without printing the matched path", () => {
    const accountName = "localdev";
    const privateHomePath = ["", "Users", accountName, "workspace"].join("/");
    const records = [
      {
        path: "docs/example.md",
        text: `Use ${privateHomePath} for this local command.\n`,
      },
    ];

    const findings = scanOssHygieneRecords(records);
    const report = renderOssHygieneReport(findings);

    expect(findings).toEqual([
      {
        column: 5,
        file: "docs/example.md",
        label: "non-example-home-path",
        line: 1,
      },
    ]);
    expect(report).not.toContain(privateHomePath);
    expect(report).not.toContain(accountName);
  });

  it("allows the public synthetic fixture names and example home paths", () => {
    const records = [
      {
        path: "packages/agent-app/src/__tests__/fixtures/consumers/local-agent-alpha/mono-agent.config.json",
        text: "Use /Users/example/local-agent-alpha and /home/example/local-agent-beta.\n",
      },
      {
        path: "packages/agent-app/src/__tests__/fixtures/consumers/local-agent-beta/mono-agent.config.json",
        text: "Fixture for local-agent-beta.\n",
      },
    ];

    expect(scanOssHygieneRecords(records)).toEqual([]);
  });

  it("scans git-tracked files and returns non-zero on findings", async () => {
    const cwd = await tempDir();
    const privateHomePath = ["", "home", "localdev", "project"].join("/");
    await writeFile(join(cwd, "tracked.md"), `Path: ${privateHomePath}\n`, "utf8");
    const stdout = sink();
    const stderr = sink();

    const result = await runCheckOssHygiene({
      cwd,
      stdout,
      stderr,
      runCommand: async (command, args) => {
        expect(command).toBe("git");
        expect(args).toEqual(["ls-files", "-z"]);
        return { status: 0, stdout: "tracked.md\0", stderr: "" };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("label=non-example-home-path");
    expect(stdout.text).not.toContain(privateHomePath);
    expect(stderr.text).toBe("");
  });
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "oss-hygiene-"));
  tempDirs.push(dir);
  return dir;
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
