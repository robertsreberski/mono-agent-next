import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DISABLED_RELEASE_AGE_POLICY_COMMENT,
  classifyExclusionSelector,
  minimumPnpmVersionForPolicy,
  parsePnpmConfigGetOutput,
  runCheckPnpmReleaseAgePolicy,
  validatePnpmReleaseAgePolicy,
} from "../pnpm-release-age-policy.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pnpm release-age policy", () => {
  it("keeps the checked-in policy explicit and its guidance honest", async () => {
    const workspaceSource = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const guidance = await readFile(join(repoRoot, "skills/pi-upstream-recon/SKILL.md"), "utf8");
    const normalizedGuidance = guidance.replace(/\s+/gu, " ");

    const cli = spawnSync(process.execPath, [join(repoRoot, "scripts/pnpm-release-age-policy.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toBe(
      "pnpm release-age policy passed: minimumReleaseAge=0; 0 exclusion(s).\n",
    );

    for (const currentPnpmVersion of ["10.16.0", "10.28.2", "11.5.2"]) {
      expect(validatePnpmReleaseAgePolicy({
        currentPnpmVersion,
        minimumReleaseAge: 0,
        minimumReleaseAgeExclude: undefined,
        npmrcSource: "",
        packageManager: packageJson.packageManager,
        pnpmEngine: packageJson.engines.pnpm,
        workspaceSource,
      })).toEqual({ exclusions: [], issues: [], minimumReleaseAge: 0 });
    }
    expect(normalizedGuidance).toContain("pnpm 10 defaults `minimumReleaseAge` to 0");
    expect(normalizedGuidance).toContain("pnpm 11 defaults it to 1440");
    expect(normalizedGuidance).toContain("requires pnpm 10.16 or newer");
    expect(normalizedGuidance).toContain("bare package names require 10.16");
  });

  it("keeps root-built isolated webapps on the explicit disabled policy", async () => {
    for (const relativePath of ["packages/web/webapp/pnpm-workspace.yaml"]) {
      const directory = dirname(join(repoRoot, relativePath));
      const source = await readFile(join(directory, "pnpm-workspace.yaml"), "utf8");

      expect(source.split(/\r?\n/u)).toContain(`# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}`);

      for (const [key, expected] of [
        ["minimumReleaseAge", 0],
        ["minimumReleaseAgeExclude", undefined],
      ]) {
        const probe = spawnSync(
          "pnpm",
          ["--dir", directory, "config", "get", key, "--location=project", "--json"],
          { cwd: repoRoot, encoding: "utf8", env: process.env },
        );
        expect(probe.status, probe.stderr).toBe(0);
        expect(parsePnpmConfigGetOutput(probe.stdout, key)).toBe(expected);
      }
    }
  });

  it("requires an explicit non-negative integer instead of inheriting a pnpm-major default", () => {
    expect(validate({ minimumReleaseAge: undefined }).issues).toContain(
      "minimumReleaseAge must be explicit because pnpm 10 and pnpm 11 have different defaults.",
    );
    for (const minimumReleaseAge of [null, "0", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validate({ minimumReleaseAge }).issues).toContain(
        "minimumReleaseAge must be a non-negative safe integer number of minutes.",
      );
    }
  });

  it("validates exclusion value shapes and disabled-policy absence", () => {
    for (const minimumReleaseAgeExclude of [null, "package-a", { package: "a" }]) {
      expect(validate({ minimumReleaseAgeExclude }).issues).toContain(
        "minimumReleaseAgeExclude must be absent or a list of non-empty strings.",
      );
    }
    expect(validate({ minimumReleaseAgeExclude: [] }).issues).toContain(
      "minimumReleaseAgeExclude must be absent while minimumReleaseAge is 0.",
    );
    expect(validate({ minimumReleaseAgeExclude: ["package-a"] }).issues).toContain(
      "minimumReleaseAgeExclude must be absent while minimumReleaseAge is 0.",
    );
    expect(validate({ minimumReleaseAgeExclude: ["package-a", 42, ""] }).issues).toEqual([
      "minimumReleaseAgeExclude entries must be non-empty strings.",
      "minimumReleaseAgeExclude entries must be non-empty strings.",
      "minimumReleaseAgeExclude must be absent while minimumReleaseAge is 0.",
    ]);
    expect(validate({ minimumReleaseAgeExclude: [" package-a "] }).issues).toContain(
      "minimumReleaseAgeExclude entries must not have surrounding whitespace.",
    );
    for (const selector of ["package-?", "package-[ab]", "package-{a,b}"]) {
      expect(enabledPolicy({ exclusions: [selector] })).toContain(
        "minimumReleaseAgeExclude entries must not use unsupported pattern metacharacters (?, [], or {}).",
      );
    }
  });

  it("classifies package, pattern, and version selectors at their real feature floors", () => {
    expect(classifyExclusionSelector("package-a")).toBe("package");
    expect(classifyExclusionSelector("@scope/package-a")).toBe("package");
    expect(classifyExclusionSelector("@scope/*")).toBe("pattern");
    expect(classifyExclusionSelector("!package-a")).toBe("pattern");
    expect(classifyExclusionSelector("package-a@1.2.3")).toBe("version");
    expect(classifyExclusionSelector("@scope/package-a@1.2.3")).toBe("version");
    expect(classifyExclusionSelector("package-a@1 || 2")).toBe("version");

    expect(minimumPnpmVersionForPolicy(["package-a"])).toEqual([10, 16, 0]);
    expect(minimumPnpmVersionForPolicy(["@scope/*"])).toEqual([10, 17, 0]);
    expect(minimumPnpmVersionForPolicy(["!package-a"])).toEqual([10, 17, 0]);
    expect(minimumPnpmVersionForPolicy(["package-a@1.2.3"])).toEqual([10, 19, 0]);
  });

  it("accepts enforced engines floors at 10.16, 10.17, and 10.19 boundaries", () => {
    expect(enabledPolicy({ exclusions: ["package-a"], pnpmEngine: ">=10.16.0", version: "10.16.0" })).toEqual([]);
    expect(enabledPolicy({ exclusions: ["@scope/*"], pnpmEngine: ">=10.17.0", version: "10.17.0" })).toEqual([]);
    expect(enabledPolicy({ exclusions: ["package-a@1.2.3"], pnpmEngine: ">=10.19.0", version: "10.19.0" })).toEqual([]);

    expect(enabledPolicy({ exclusions: ["@scope/*"], pnpmEngine: ">=10.16.0", version: "10.17.0" })).toContain(
      "Release-age policy requires packageManager to pin pnpm >=10.17.0 or engines.pnpm to enforce >=10.17.0.",
    );
    expect(enabledPolicy({ exclusions: ["package-a@1.2.3"], pnpmEngine: ">=10.18.0", version: "10.19.0" })).toContain(
      "Release-age policy requires packageManager to pin pnpm >=10.19.0 or engines.pnpm to enforce >=10.19.0.",
    );
    expect(enabledPolicy({ exclusions: ["package-a"], pnpmEngine: ">=10.16.0 <11", version: "10.16.0" })).toEqual([]);
    for (const pnpmEngine of [">=10.16.0 <=garbage", ">=11 <10", `>=${Number.MAX_SAFE_INTEGER + 1}`]) {
      expect(enabledPolicy({ exclusions: ["package-a"], pnpmEngine, version: "10.16.0" })).toContain(
        "Release-age policy requires packageManager to pin pnpm >=10.16.0 or engines.pnpm to enforce >=10.16.0.",
      );
    }
  });

  it("treats exact packageManager pins and enforced engines floors as alternatives", () => {
    expect(enabledPolicy({
      exclusions: ["package-a@1.2.3"],
      packageManager: "pnpm@10.18.0",
      pnpmEngine: ">=10.19.0",
      version: "10.19.0",
    })).toEqual([]);
    expect(enabledPolicy({
      exclusions: ["package-a@1.2.3"],
      packageManager: "pnpm@10.19.0",
      pnpmEngine: ">=10",
      version: "10.19.0",
    })).toEqual([]);
    expect(enabledPolicy({
      exclusions: ["package-a@1.2.3"],
      packageManager: `pnpm@10.19.0+sha512.${"a".repeat(128)}`,
      version: "10.19.0",
    })).toEqual([]);
    expect(enabledPolicy({
      exclusions: ["package-a"],
      packageManager: "pnpm@latest",
      pnpmEngine: ">=10",
      version: "10.28.2",
    })).toContain(
      "Release-age policy requires packageManager to pin pnpm >=10.16.0 or engines.pnpm to enforce >=10.16.0.",
    );
    for (const packageManager of [
      "pnpm@10.19.0+garbage",
      "pnpm@10.19.0+sha512.a",
      "PNPM@10.19.0",
      "pnpm@010.19.0",
      `pnpm@${Number.MAX_SAFE_INTEGER + 1}.19.0`,
    ]) {
      expect(enabledPolicy({
        exclusions: ["package-a@1.2.3"],
        packageManager,
        pnpmEngine: ">=10",
        version: "10.19.0",
      })).toContain(
        "Release-age policy requires packageManager to pin pnpm >=10.19.0 or engines.pnpm to enforce >=10.19.0.",
      );
    }
    expect(enabledPolicy({
      exclusions: ["package-a@1.2.3"],
      pnpmEngine: ">=10.19.0",
      version: "10.18.0",
    })).toContain("Running pnpm must be >=10.19.0 for the configured release-age policy.");
    expect(validate({ currentPnpmVersion: "10.15.9" }).issues).toContain(
      "Running pnpm must be >=10.16.0 for the configured release-age policy.",
    );
  });

  it("rejects missing or stale disabled-policy comments", () => {
    expect(validate({ workspaceSource: "minimumReleaseAge: 0\n" }).issues).toContain(
      `Workspace must state "${DISABLED_RELEASE_AGE_POLICY_COMMENT}" while the cooldown is disabled.`,
    );
    expect(enabledPolicy({
      workspaceSource: `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}\nminimumReleaseAge: 1440\n`,
    })).toContain(
      `Workspace comment says "${DISABLED_RELEASE_AGE_POLICY_COMMENT}" but minimumReleaseAge is positive.`,
    );
    for (const workspaceSource of [
      `policyNote: "${DISABLED_RELEASE_AGE_POLICY_COMMENT}"\nminimumReleaseAge: 0\n`,
      `  # ${DISABLED_RELEASE_AGE_POLICY_COMMENT}\nminimumReleaseAge: 0\n`,
      `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT} extra\nminimumReleaseAge: 0\n`,
    ]) {
      expect(validate({ workspaceSource }).issues).toContain(
        `Workspace must state "${DISABLED_RELEASE_AGE_POLICY_COMMENT}" while the cooldown is disabled.`,
      );
    }
  });

  it("rejects kebab, camel, spaced, and array release-age keys in root .npmrc", () => {
    const result = validate({
      npmrcSource: [
        "minimum-release-age = 1440",
        "minimumReleaseAgeExclude[]=package-a",
        "minimum-release-age-exclude = package-b",
      ].join("\n"),
    });

    expect(result.issues).toContain(
      "Release-age policy must live only in pnpm-workspace.yaml; remove minimum-release-age, minimum-release-age-exclude, minimumReleaseAgeExclude from .npmrc.",
    );
    expect(validate({
      npmrcSource: [
        "# minimum-release-age=1440",
        "; minimumReleaseAgeExclude[]=package-a",
        "unrelated = value",
      ].join("\n"),
    }).issues).toEqual([]);
  });

  it("parses pnpm config JSON without treating an absent key as an effective default", () => {
    expect(parsePnpmConfigGetOutput("", "minimumReleaseAgeExclude")).toBeUndefined();
    expect(parsePnpmConfigGetOutput("undefined\n", "minimumReleaseAgeExclude")).toBeUndefined();
    expect(parsePnpmConfigGetOutput("0\n", "minimumReleaseAge")).toBe(0);
    expect(parsePnpmConfigGetOutput("[]\n", "minimumReleaseAgeExclude")).toEqual([]);
    expect(parsePnpmConfigGetOutput('"package-a"\n', "minimumReleaseAgeExclude")).toBe("package-a");
    expect(() => parsePnpmConfigGetOutput("not-json", "minimumReleaseAge")).toThrow(
      /did not return JSON/u,
    );
  });

  it("runs the named check against parsed pnpm values", async () => {
    const stdout = sink();
    const stderr = sink();
    const result = await runCheckPnpmReleaseAgePolicy({
      argv: [],
      cwd: "/repo",
      stdout,
      stderr,
      readText: fakeRepoReader(),
      runPnpm: fakePnpm({ age: "0\n", exclusions: "\n", version: "10.28.2\n" }),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("minimumReleaseAge=0; 0 exclusion(s)");
    expect(stderr.text).toBe("");

    const scalarError = sink();
    const scalarResult = await runCheckPnpmReleaseAgePolicy({
      argv: [],
      cwd: "/repo",
      stdout: sink(),
      stderr: scalarError,
      readText: fakeRepoReader(),
      runPnpm: fakePnpm({ age: "0\n", exclusions: '"package-a"\n', version: "10.28.2\n" }),
    });
    expect(scalarResult.exitCode).toBe(1);
    expect(scalarError.text).toContain("minimumReleaseAgeExclude must be absent or a list");

    const oldPnpmError = sink();
    const oldPnpmResult = await runCheckPnpmReleaseAgePolicy({
      argv: [],
      cwd: "/repo",
      stdout: sink(),
      stderr: oldPnpmError,
      readText: fakeRepoReader(),
      runPnpm: fakePnpm({ age: "0\n", exclusions: "\n", version: "10.15.9\n" }),
    });
    expect(oldPnpmResult.exitCode).toBe(1);
    expect(oldPnpmError.text).toContain(
      "Running pnpm must be >=10.16.0 to read the release-age policy.",
    );
  });

  it("uses pnpm's YAML parser for quoted and spaced keys", async () => {
    const cwd = await tempRepo([
      `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}`,
      '"minimumReleaseAge" : 0',
      "packages: []",
      "",
    ].join("\n"));
    const result = await runCheckPnpmReleaseAgePolicy({
      argv: [],
      cwd,
      stdout: sink(),
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
  });

  it("rejects the reviewer's quoted-key and spaced-key bypass mutations", async () => {
    const quotedAgeCwd = await tempRepo([
      `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}`,
      '"minimumReleaseAge": 1440',
      "packages: []",
      "",
    ].join("\n"), { engines: { pnpm: ">=10.16.0" } });
    const quotedAgeError = sink();
    expect((await runCheckPnpmReleaseAgePolicy({
      argv: [], cwd: quotedAgeCwd, stdout: sink(), stderr: quotedAgeError,
    })).exitCode).toBe(1);
    expect(quotedAgeError.text).toContain("but minimumReleaseAge is positive");

    const spacedExclusionCwd = await tempRepo([
      `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}`,
      "minimumReleaseAge: 0",
      "minimumReleaseAgeExclude :",
      "  - package-a",
      "packages: []",
      "",
    ].join("\n"));
    const spacedExclusionError = sink();
    expect((await runCheckPnpmReleaseAgePolicy({
      argv: [], cwd: spacedExclusionCwd, stdout: sink(), stderr: spacedExclusionError,
    })).exitCode).toBe(1);
    expect(spacedExclusionError.text).toContain("must be absent while");

    const emptyExclusionCwd = await tempRepo([
      `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}`,
      "minimumReleaseAge: 0",
      "minimumReleaseAgeExclude : []",
      "packages: []",
      "",
    ].join("\n"));
    const emptyExclusionError = sink();
    expect((await runCheckPnpmReleaseAgePolicy({
      argv: [], cwd: emptyExclusionCwd, stdout: sink(), stderr: emptyExclusionError,
    })).exitCode).toBe(1);
    expect(emptyExclusionError.text).toContain("must be absent while");
  }, 15_000);

  it("isolates committed policy reads from release-age environment and user config", async () => {
    const cwd = await tempRepo([
      `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}`,
      "minimumReleaseAge: 0",
      "packages: []",
      "",
    ].join("\n"));
    const pollutedUserConfig = join(cwd, "polluted-user.npmrc");
    const pollutedGlobalConfig = join(cwd, "polluted-global.npmrc");
    await writeFile(pollutedUserConfig, "minimumReleaseAgeExclude[]=polluted-package\n", "utf8");
    await writeFile(pollutedGlobalConfig, "minimumReleaseAgeExclude[]=global-package\n", "utf8");
    const environment = {
      ...process.env,
      NPM_CONFIG_GLOBALCONFIG: pollutedGlobalConfig,
      NPM_CONFIG_USERCONFIG: pollutedUserConfig,
      npm_config_minimum_release_age: "1440",
      PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: "polluted-package",
    };
    const cli = spawnSync(process.execPath, [join(repoRoot, "scripts/pnpm-release-age-policy.mjs")], {
      cwd,
      encoding: "utf8",
      env: environment,
    });

    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain("minimumReleaseAge=0; 0 exclusion(s)");
  });

  it("rejects scalar and malformed YAML through the real pnpm parser path", async () => {
    const scalarCwd = await tempRepo([
      "minimumReleaseAge: 1440",
      "minimumReleaseAgeExclude: package-a",
      "packages: []",
      "",
    ].join("\n"));
    const scalarError = sink();
    expect((await runCheckPnpmReleaseAgePolicy({
      argv: [], cwd: scalarCwd, stdout: sink(), stderr: scalarError,
    })).exitCode).toBe(1);
    expect(scalarError.text).toContain("minimumReleaseAgeExclude must be absent or a list");

    const malformedCwd = await tempRepo("minimumReleaseAge: [\npackages: []\n");
    const malformedError = sink();
    expect((await runCheckPnpmReleaseAgePolicy({
      argv: [], cwd: malformedCwd, stdout: sink(), stderr: malformedError,
    })).exitCode).toBe(1);
    expect(malformedError.text).toContain("pnpm --version failed");
  });

  it("wires the named check before install and into verify:all", async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const ci = await readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const release = await readFile(join(repoRoot, ".github/workflows/npm-release.yml"), "utf8");
    const verifyAll = await readFile(join(repoRoot, "scripts/verify-all.mjs"), "utf8");

    const expectedLifecycle =
      "node scripts/node-version.mjs && node scripts/pnpm-release-age-policy.mjs";
    expect(packageJson.engines.pnpm).toBe(">=10.16.0");
    expect(packageJson.scripts["check:pnpm-policy"]).toBe("node scripts/pnpm-release-age-policy.mjs");
    expect(packageJson.scripts["pnpm:devPreinstall"]).toBe(expectedLifecycle);
    expect(packageJson.scripts.preinstall).toBe(expectedLifecycle);
    const ciVerifyJob = ci.split("\n  website:")[0];
    for (const workflow of [ciVerifyJob, release]) {
      expect(workflow).toContain([
        "      - name: Enable Corepack",
        "        run: corepack enable",
        "",
        "      - name: Check pnpm release-age policy",
        "        run: node scripts/pnpm-release-age-policy.mjs",
      ].join("\n"));
      const directGuard = workflow.indexOf("run: node scripts/pnpm-release-age-policy.mjs");
      expect(directGuard).toBeGreaterThan(-1);
      expect(directGuard).toBeLessThan(workflow.indexOf("run: pnpm "));
      expect(workflow).not.toContain("run: pnpm run check:pnpm-policy");
    }
    const websiteJob = /\n  website:(?<body>[\s\S]*?)(?=\n  [a-z][a-z0-9-]*:|\s*$)/u.exec(ci)?.groups?.body;
    expect(websiteJob).toBeDefined();
    expect(websiteJob).not.toContain("scripts/pnpm-release-age-policy.mjs");
    expect(verifyAll).toContain('{ label: "check:pnpm-policy"');
  });
});

function validate(overrides = {}) {
  return validatePnpmReleaseAgePolicy({
    currentPnpmVersion: "10.28.2",
    minimumReleaseAge: 0,
    minimumReleaseAgeExclude: undefined,
    npmrcSource: "",
    packageManager: undefined,
    pnpmEngine: ">=10.16.0",
    workspaceSource: `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}\nminimumReleaseAge: 0\n`,
    ...overrides,
  });
}

function enabledPolicy(overrides = {}) {
  return validatePnpmReleaseAgePolicy({
    currentPnpmVersion: overrides.version ?? "10.28.2",
    minimumReleaseAge: 1440,
    minimumReleaseAgeExclude: overrides.exclusions ?? [],
    npmrcSource: "",
    packageManager: overrides.packageManager,
    pnpmEngine: overrides.pnpmEngine ?? ">=10.16.0",
    workspaceSource: overrides.workspaceSource ?? "minimumReleaseAge: 1440\n",
  }).issues;
}

function fakeRepoReader() {
  return async (path) => {
    if (path.endsWith("package.json")) {
      return JSON.stringify({ engines: { pnpm: ">=10.16.0" } });
    }
    if (path.endsWith("pnpm-workspace.yaml")) {
      return `# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}\nminimumReleaseAge: 0\n`;
    }
    if (path.endsWith(".npmrc")) {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
    throw new Error(`Unexpected read: ${path}`);
  };
}

function fakePnpm(input) {
  return async (args) => {
    if (args[0] === "--version") {
      return { status: 0, stdout: input.version, stderr: "" };
    }
    const value = args[2] === "minimumReleaseAge" ? input.age : input.exclusions;
    return { status: 0, stdout: value, stderr: "" };
  };
}

async function tempRepo(workspaceSource, packageJson = { engines: { pnpm: ">=10.16.0" } }) {
  const cwd = await mkdtemp(join(tmpdir(), "pnpm-policy-"));
  tempDirs.push(cwd);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "pnpm-workspace.yaml"), workspaceSource, "utf8");
  await writeFile(join(cwd, "package.json"), JSON.stringify({ private: true, ...packageJson }), "utf8");
  return cwd;
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
