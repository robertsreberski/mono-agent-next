import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  it("flags private fleet, persona, endpoint, and email references without printing them", () => {
    const employer = ["A8", "C"].join("");
    const fleetPath = `~/${["personal", "agent"].join("-")}`;
    const persona = ["Inner", " Child"].join("");
    const port = ["54", "18"].join("");
    const email = `${["roberts", "reberski"].join("")}@${["gmail", "com"].join(".")}`;
    const text = [employer, fleetPath, persona, port, email].join("\n");

    const findings = scanOssHygieneRecords([{ path: "notes.md", text }]);
    const report = renderOssHygieneReport(findings);

    expect(findings.map((finding) => finding.label)).toEqual([
      "employer-reference",
      "private-fleet-path",
      "private-persona-reference",
      "private-service-identifier",
      "personal-email-outside-authors",
    ]);
    for (const value of [employer, fleetPath, persona, port, email]) {
      expect(report).not.toContain(value);
    }
  });

  it("flags private identifiers across config and slug delimiters", () => {
    const employerKey = `${["A8", "C"].join("")}_SLACK_TOKEN`;
    const personaSlugs = [
      ["sleep", "ambra"].join("-"),
      ["therapy", "council"].join("-"),
      ["inner", "child"].join("-"),
    ];
    const findings = scanOssHygieneRecords([{
      path: "config.json",
      text: [employerKey, ...personaSlugs].join("\n"),
    }]);

    expect(findings.map((finding) => finding.label)).toEqual([
      "employer-reference",
      "private-persona-reference",
      "private-persona-reference",
      "private-persona-reference",
    ]);
  });

  it("allows the author email only in AUTHORS and keeps generic examples public", () => {
    const email = `${["roberts", "reberski"].join("")}@${["gmail", "com"].join(".")}`;
    const records = [
      { path: "AUTHORS.md", text: `${email}\n` },
      {
        path: "docs/example.md",
        text: "Personal Agent template at /Users/example/agent and /home/user/agent.\n",
      },
    ];

    expect(scanOssHygieneRecords(records)).toEqual([]);
  });

  it("flags private references in tracked pathnames without printing them", () => {
    const employerPath = ["docs", `${["a8", "c"].join("")}-internal.md`].join("/");
    const servicePath = ["notes", `${["personal", "agent", "059657c8"].join("-")}.md`].join("/");
    const findings = scanOssHygieneRecords([
      { path: employerPath, text: "Public-looking content.\n" },
      { path: servicePath, text: undefined },
    ]);
    const report = renderOssHygieneReport(findings);

    expect(findings.map((finding) => finding.label)).toEqual([
      "employer-reference",
      "private-service-identifier",
    ]);
    expect(report).toContain("[redacted-tracked-path]:0:1");
    expect(report).not.toContain(employerPath);
    expect(report).not.toContain(servicePath);
    expect(scanOssHygieneRecords([{
      path: "docs/personal-agent-template.md",
      text: "Public Personal Agent template.\n",
    }])).toEqual([]);
  });

  it("flags and redacts non-example home paths in tracked pathnames", () => {
    const employer = ["A8", "C"].join("");
    const privatePath = ["snapshots", "Users", "localdev", "report.md"].join("/");
    const findings = scanOssHygieneRecords([
      { path: privatePath, text: `${employer}\n` },
    ]);
    const report = renderOssHygieneReport(findings);

    expect(findings.map(({ file, label, line }) => ({ file, label, line }))).toEqual([
      {
        file: "[redacted-tracked-path]",
        label: "non-example-home-path",
        line: 0,
      },
      {
        file: "[redacted-tracked-path]",
        label: "employer-reference",
        line: 1,
      },
    ]);
    expect(report).not.toContain(privatePath);
    expect(report).not.toContain("localdev");
  });

  it("flags real-looking home directories without printing the matched path", () => {
    const accountName = "localdev";
    const privateHomePath = ["", "Users", accountName, "workspace"].join("/");
    const findings = scanOssHygieneRecords([
      { path: "docs/example.md", text: `Use ${privateHomePath} for this command.\n` },
    ]);
    const report = renderOssHygieneReport(findings);

    expect(findings).toEqual([{
      column: 5,
      file: "docs/example.md",
      label: "non-example-home-path",
      line: 1,
    }]);
    expect(report).not.toContain(privateHomePath);
    expect(report).not.toContain(accountName);
  });

  it("flags Windows home directories case-insensitively while allowing examples", () => {
    const accountName = "privateuser";
    const privateHomePath = ["C:", "Users", accountName, "workspace"].join("\\");
    const findings = scanOssHygieneRecords([
      {
        path: "docs/windows.md",
        text: `${privateHomePath}\nC:\\Users\\Example\\workspace\n`,
      },
    ]);
    const report = renderOssHygieneReport(findings);

    expect(findings).toEqual([{
      column: 1,
      file: "docs/windows.md",
      label: "non-example-home-path",
      line: 1,
    }]);
    expect(report).not.toContain(privateHomePath);
    expect(report).not.toContain(accountName);
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

  it("rejects tracked symlinks without following or printing their targets", async () => {
    const cwd = await tempDir();
    const accountName = "privateaccount";
    const target = ["", "Users", accountName, "secret"].join("/");
    await symlink(target, join(cwd, "tracked-link"));
    const stdout = sink();

    const result = await runCheckOssHygiene({
      cwd,
      stdout,
      stderr: sink(),
      runCommand: async () => ({
        status: 0,
        stdout: "tracked-link\0",
        stderr: "",
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.findings.map((finding) => finding.label)).toEqual([
      "tracked-symlink",
      "non-example-home-path",
    ]);
    expect(stdout.text).not.toContain(target);
    expect(stdout.text).not.toContain(accountName);
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
