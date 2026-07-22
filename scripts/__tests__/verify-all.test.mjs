import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { Scalar, isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

import { MINIMUM_NODE_VERSION } from "../node-version.mjs";
import {
  CI_RELEASE_TAG_EXPRESSION,
  VERIFY_GATE_DELTA,
  createRepoGate,
  readReleaseSmokeTag,
  runVerifyAll,
} from "../verify-all.mjs";

const EXPECTED_CI_NODE_MATRIX = Object.freeze([MINIMUM_NODE_VERSION, "24"]);
const CI_CHECKOUT_STEP = [
  "      - name: Checkout",
  "        uses: actions/checkout@v4",
].join("\n");
const CI_SETUP_NODE_STEP = [
  "      - name: Setup Node",
  "        uses: actions/setup-node@v4",
  "        with:",
  "          node-version: \"${{ matrix.node-version }}\"",
].join("\n");
const CI_ACTION_SEQUENCE = `${CI_CHECKOUT_STEP}\n\n${CI_SETUP_NODE_STEP}`;

describe("verify-all", () => {
  it("runs the repo gate in order, then ends with one exact green verdict", async () => {
    const stdout = sink();
    const execution = [];
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.11.2",
      nodeVersion: MINIMUM_NODE_VERSION,
      stdout,
      stderr: sink(),
      runCommand: async (command, args, options) => {
        execution.push(options.label);
        if (options.label === "release:validate") {
          expect({ command, args }).toEqual({
            command: "pnpm",
            args: ["run", "release:validate", "--", "--tag", "v0.11.2"],
          });
        }
        if (options.label === "release:pack") {
          expect({ command, args }).toEqual({
            command: "pnpm",
            args: ["run", "release:pack", "--", "--tag", "v0.11.2"],
          });
        }
        if (options.label === "release:consumer") {
          expect({ command, args }).toEqual({
            command: "pnpm",
            args: ["run", "release:consumer", "--", "--tag", "v0.11.2", "--require-minimum"],
          });
        }
        return 0;
      },
      verifyConsumers: async (options) => {
        execution.push("verify:consumers");
        expect(options.argv).toEqual(["--skip-build"]);
        return {
          exitCode: 0,
          statusByLabel: new Map([
            ["local-agent-alpha contract", true],
            ["local-agent-beta contract", true],
          ]),
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(execution).toEqual([
      "check:node",
      "check:pnpm-policy",
      "check:secrets",
      "check:oss-hygiene",
      "check:licenses",
      "check:dependency-vulnerabilities",
      "check:codex-discoverability",
      "check:consumer-docs-consistency",
      "check:getting-started-version-pins",
      "check:docs",
      "release:validate",
      "check:architecture",
      "build",
      "check:doc-snippets",
      "check:deep-imports",
      "verify:consumers",
      "release:pack",
      "release:consumer",
      "typecheck",
      "test",
      "test:demo",
      "git diff --check",
    ]);
    expect(stdout.text.endsWith([
      "final summary",
      "repo ok",
      "local-agent-alpha contract ok",
      "local-agent-beta contract ok",
      "verification green",
      "",
    ].join("\n"))).toBe(true);
  });

  it("exits non-zero and skips consumers when a pre-build repo gate fails", async () => {
    const stdout = sink();
    const stderr = sink();
    let verifyConsumersCalled = false;
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.11.2",
      stdout,
      stderr,
      runCommand: async (_command, _args, options) => options.label === "check:architecture" ? 1 : 0,
      verifyConsumers: async () => {
        verifyConsumersCalled = true;
        return {
          exitCode: 0,
          statusByLabel: new Map(),
        };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(verifyConsumersCalled).toBe(false);
    expect(stderr.text).toContain("Repo gate failed at check:architecture.");
    expect(stderr.text).toContain("Consumer verification skipped");
    expect(stdout.text).toContain("repo fail");
    expect(stdout.text).toContain("local-agent-alpha contract fail");
    expect(stdout.text).toContain("local-agent-beta contract fail");
    expect(stdout.text).toContain("verification failed");
  });

  it("fails fast before release and test commands when a consumer verdict is not green", async () => {
    const stdout = sink();
    const stderr = sink();
    const execution = [];
    const result = await runVerifyAll({
      argv: [],
      cwd: "/repo",
      releaseTag: "v0.11.2",
      stdout,
      stderr,
      runCommand: async (_command, _args, options) => {
        execution.push(options.label);
        return 0;
      },
      verifyConsumers: async () => {
        execution.push("verify:consumers");
        return {
          exitCode: 1,
          statusByLabel: new Map([
            ["local-agent-alpha contract", true],
            ["local-agent-beta contract", false],
          ]),
        };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(execution).toEqual([
      "check:node",
      "check:pnpm-policy",
      "check:secrets",
      "check:oss-hygiene",
      "check:licenses",
      "check:dependency-vulnerabilities",
      "check:codex-discoverability",
      "check:consumer-docs-consistency",
      "check:getting-started-version-pins",
      "check:docs",
      "release:validate",
      "check:architecture",
      "build",
      "check:doc-snippets",
      "check:deep-imports",
      "verify:consumers",
    ]);
    expect(stderr.text).toBe("Consumer gate failed at verify:consumers; later repo gates skipped.\n");
    expect(stdout.text).toBe([
      "final summary",
      "repo fail",
      "local-agent-alpha contract ok",
      "local-agent-beta contract fail",
      "verification failed",
      "",
    ].join("\n"));
  });

  it("runs packed-consumer smoke coverage on newer Node without claiming the minimum-version proof", () => {
    const releaseConsumer = createRepoGate({
      releaseTag: "v0.11.2",
      nodeVersion: "24.0.0",
    }).find((command) => command.label === "release:consumer");

    expect(releaseConsumer).toEqual({
      label: "release:consumer",
      command: "pnpm",
      args: ["run", "release:consumer", "--", "--tag", "v0.11.2"],
    });
  });

  it("derives the release smoke tag from the agent-app manifest", () => {
    const calls = [];
    expect(readReleaseSmokeTag("/repo", (path, encoding) => {
      calls.push({ path, encoding });
      return JSON.stringify({ version: "1.2.3-beta.1" });
    })).toBe("v1.2.3-beta.1");
    expect(calls).toEqual([{
      path: "/repo/packages/agent-app/package.json",
      encoding: "utf8",
    }]);
  });

  it("keeps every CI matrix leg at the exact documented semantic delta from verify-all", () => {
    expectCiParity(readCiWorkflow());
  });

  it("requires a PR release dry run and publishes one aggregate CI verdict", () => {
    const workflow = parseDocument(readCiWorkflow(), { uniqueKeys: true }).toJS();
    const releaseDryRun = workflow.jobs["release-dry-run"];
    const verdict = workflow.jobs.verdict;

    expect(releaseDryRun.name).toBe("Release dry run");
    expect(releaseDryRun.if).toBe("github.event_name == 'pull_request'");
    expect(releaseDryRun.needs).toBe("verify");
    expect(releaseDryRun.steps.some((step) =>
      typeof step.run === "string"
      && step.run.includes("pnpm run release:publish -- --dry-run --tag \"$TAG\""),
    )).toBe(true);

    expect(verdict.name).toBe("Required verdict");
    expect(verdict.if).toBe("always()");
    expect(verdict.needs).toEqual(["verify", "website", "release-dry-run"]);
    expect(verdict.steps).toHaveLength(1);
    expect(verdict.steps[0].run).toContain("CI VERDICT: GREEN");
    expect(verdict.steps[0].run).toContain("CI VERDICT: FAILED");
    expect(Object.values(workflow.jobs).filter((job) => job.name === "Required verdict")).toHaveLength(1);
  });

  it("rejects deleting, moving, or changing the pnpm policy gate", () => {
    const source = readCiWorkflow();
    const corepack = [
      "      - name: Enable Corepack",
      "        run: corepack enable",
    ].join("\n");
    const policy = [
      "      - name: Check pnpm release-age policy",
      "        run: node scripts/pnpm-release-age-policy.mjs",
    ].join("\n");
    const nodeCheck = [
      "      - name: Check Node support floor",
      "        run: pnpm run check:node",
    ].join("\n");
    const mutations = [
      replaceExactly(source, `${policy}\n\n`, ""),
      replaceExactly(
        source,
        `${corepack}\n\n${policy}\n\n${nodeCheck}`,
        `${corepack}\n\n${nodeCheck}\n\n${policy}`,
      ),
      replaceExactly(
        source,
        "        run: node scripts/pnpm-release-age-policy.mjs",
        "        run: node scripts/pnpm-release-age-policy.mjs --help",
      ),
    ];

    for (const mutation of mutations) {
      expect(() => expectCiParity(mutation)).toThrow();
    }
  });

  it("rejects release argv drift that removes the minimum-version proof", () => {
    const source = readCiWorkflow();
    const original = "        run: pnpm run release:consumer -- --tag \"${{ steps.release-smoke.outputs.tag }}\" --require-minimum";
    const mutated = "        run: pnpm run release:consumer -- --tag \"${{ steps.release-smoke.outputs.tag }}\"";
    const mutatedSource = replaceExactly(source, original, mutated);

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects moving the packed consumer condition to another Node version", () => {
    const source = readCiWorkflow();
    const original = [
      "      - name: Install packed consumer at the minimum Node version",
      "        if: ${{ matrix.node-version == '22.19.0' }}",
    ].join("\n");
    const mutated = [
      "      - name: Install packed consumer at the minimum Node version",
      "        if: ${{ matrix.node-version == '24' }}",
    ].join("\n");
    const mutatedSource = replaceExactly(source, original, mutated);

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects shared gate reordering", () => {
    const source = readCiWorkflow();
    const consumer = [
      "      - name: Verify consumer contracts",
      "        run: pnpm run verify:consumers --skip-build",
    ].join("\n");
    const pack = [
      "      - name: Validate package tarballs",
      "        run: pnpm run release:pack -- --tag \"${{ steps.release-smoke.outputs.tag }}\"",
    ].join("\n");
    const mutatedSource = replaceExactly(source, `${consumer}\n\n${pack}`, `${pack}\n\n${consumer}`);

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects stale intentional-delta declarations", () => {
    const source = readCiWorkflow();
    const testStep = [
      "      - name: Run tests",
      "        run: pnpm test",
    ].join("\n");
    const localOnlyStep = [
      "      - name: Test demos",
      "        run: pnpm run test:demo",
    ].join("\n");
    const mutatedSource = replaceExactly(source, testStep, `${testStep}\n\n${localOnlyStep}`);

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects executable gate steps that omit a display name", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const unnamedDuplicate = "      - run: pnpm run check:architecture";
    const mutatedSource = replaceExactly(
      source,
      architecture,
      `${architecture}\n\n${unnamedDuplicate}`,
    );

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("reads quoted keys, spaced colons, and dash-alone step mappings semantically", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const alternateYaml = [
      "      -",
      "        \"name\" : Check package architecture",
      "        \"run\" : \"pnpm run check:architecture\"",
    ].join("\n");

    expectCiParity(replaceExactly(source, architecture, alternateYaml));
  });

  it("rejects extra dash-alone steps with quoted execution keys", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const hiddenDuplicate = [
      "      -",
      "        \"run\" : pnpm run check:architecture",
    ].join("\n");
    const mutatedSource = replaceExactly(
      source,
      architecture,
      `${architecture}\n\n${hiddenDuplicate}`,
    );

    expect(() => expectCiParity(mutatedSource)).toThrow();
  });

  it("rejects alternate YAML spellings of hidden with, if, and continue-on-error fields", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const mutations = [
      [
        "      - name: Check package architecture",
        "        \"with\" :",
        "          cache: pnpm",
        "        run: pnpm run check:architecture",
      ].join("\n"),
      [
        "      - name: Check package architecture",
        "        \"if\" : ${{ github.ref == 'refs/heads/main' }}",
        "        run: pnpm run check:architecture",
      ].join("\n"),
      [
        "      - name: Check package architecture",
        "        \"continue-on-error\" : true",
        "        run: pnpm run check:architecture",
      ].join("\n"),
    ];

    for (const mutation of mutations) {
      const mutatedSource = replaceExactly(source, architecture, mutation);
      expect(() => expectCiParity(mutatedSource)).toThrow();
    }
  });

  it("rejects YAML aliases, merge keys, and duplicate semantic keys", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const anchoredAlias = [
      "      - &architecture-step",
      "        name: Check package architecture",
      "        run: pnpm run check:architecture",
      "      - *architecture-step",
    ].join("\n");
    const mergeKey = [
      "      - name: Check package architecture",
      "        <<: { continue-on-error: true }",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const duplicateKey = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
      "        \"run\" : pnpm run typecheck",
    ].join("\n");

    expect(() => parseCiVerifyJob(replaceExactly(source, architecture, anchoredAlias)))
      .toThrow(/YAML anchors|YAML aliases/u);
    expect(() => parseCiVerifyJob(replaceExactly(source, architecture, mergeKey)))
      .toThrow(/YAML merge keys|strict YAML/u);
    expect(() => parseCiVerifyJob(replaceExactly(source, architecture, duplicateKey)))
      .toThrow(/strict YAML|Duplicate YAML field/u);
  });

  it("rejects unmodeled execution fields on the workflow and verify job", () => {
    const source = readCiWorkflow();
    const jobOriginal = [
      "    timeout-minutes: 60",
      "    strategy:",
    ].join("\n");
    const jobDefaults = [
      "    timeout-minutes: 60",
      "    \"defaults\" : { run: { shell: bash } }",
      "    strategy:",
    ].join("\n");
    const workflowOriginal = [
      "permissions:",
      "  contents: read",
      "",
      "concurrency:",
    ].join("\n");
    const workflowDefaults = [
      "permissions:",
      "  contents: read",
      "",
      "\"defaults\" : { run: { shell: bash } }",
      "",
      "concurrency:",
    ].join("\n");

    expect(() => parseCiVerifyJob(replaceExactly(source, jobOriginal, jobDefaults)))
      .toThrow(/Unsupported CI verify job field/u);
    expect(() => parseCiVerifyJob(replaceExactly(source, workflowOriginal, workflowDefaults)))
      .toThrow(/Unsupported CI workflow field/u);
  });

  it("treats display names as non-semantic metadata", () => {
    const source = readCiWorkflow();
    const actionsRenamed = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      CI_ACTION_SEQUENCE
        .replace("name: Checkout", "name: Renamed checkout display")
        .replace("name: Setup Node", "name: Renamed setup display"),
    );
    const mutatedSource = replaceExactly(
      actionsRenamed,
      "      - name: Check package architecture",
      "      - name: Renamed architecture display",
    );

    expectCiParity(mutatedSource);
  });

  it("rejects replaced or unknown CI actions", () => {
    const source = readCiWorkflow();
    const replacedSetup = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      CI_ACTION_SEQUENCE.replace("actions/setup-node@v4", "example.invalid/reviewer-setup@v1"),
    );
    const unknownAction = "      - uses: example.invalid/reviewer-action@v1";
    const insertedUnknown = replaceExactly(
      source,
      CI_SETUP_NODE_STEP,
      `${CI_SETUP_NODE_STEP}\n\n${unknownAction}`,
    );

    expect(() => parseCiVerifyJob(replacedSetup)).toThrow(/Unclassified CI action step/u);
    expect(() => parseCiVerifyJob(insertedUnknown)).toThrow(/Unclassified CI action step/u);
  });

  it("rejects setup-node input drift and unmodeled nested inputs", () => {
    const source = readCiWorkflow();
    const matrixInput = "          node-version: \"${{ matrix.node-version }}\"";
    const fixedVersion = replaceExactly(source, matrixInput, "          node-version: 20");
    const missingVersion = replaceExactly(source, `${matrixInput}\n`, "");
    const extraCacheInput = replaceExactly(
      source,
      matrixInput,
      `${matrixInput}\n          cache: pnpm`,
    );

    expect(() => parseCiVerifyJob(fixedVersion)).toThrow(/CI action inputs drifted: Node setup/u);
    expect(() => parseCiVerifyJob(missingVersion)).toThrow(/CI action inputs drifted: Node setup/u);
    expect(() => parseCiVerifyJob(extraCacheInput)).toThrow(/CI action inputs drifted: Node setup/u);
  });

  it("rejects missing and duplicated required CI actions", () => {
    const source = readCiWorkflow();
    const missingSetup = replaceExactly(source, `${CI_SETUP_NODE_STEP}\n\n`, "");
    const duplicateCheckout = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      `${CI_CHECKOUT_STEP}\n\n${CI_ACTION_SEQUENCE}`,
    );

    expect(() => expectCiParity(missingSetup)).toThrow();
    expect(() => expectCiParity(duplicateCheckout)).toThrow();
  });

  it("rejects CI action reordering and movement past run steps", () => {
    const source = readCiWorkflow();
    const reordered = replaceExactly(
      source,
      CI_ACTION_SEQUENCE,
      `${CI_SETUP_NODE_STEP}\n\n${CI_CHECKOUT_STEP}`,
    );
    const corepackStep = [
      "      - name: Enable Corepack",
      "        run: corepack enable",
    ].join("\n");
    const movedPastCorepack = replaceExactly(
      source,
      `${CI_ACTION_SEQUENCE}\n\n${corepackStep}`,
      `${CI_CHECKOUT_STEP}\n\n${corepackStep}\n\n${CI_SETUP_NODE_STEP}`,
    );

    expect(() => parseCiVerifyJob(reordered)).toThrow(/must remain at verify-step position/u);
    expect(() => parseCiVerifyJob(movedPastCorepack)).toThrow(/must remain at verify-step position/u);
  });

  it("rejects folded run blocks that change release-tag shell semantics", () => {
    const source = readCiWorkflow();
    const original = [
      "      - name: Derive release smoke tag",
      "        id: release-smoke",
      "        run: |",
    ].join("\n");
    const folded = original.replace("run: |", "run: >");
    const mutatedSource = replaceExactly(source, original, folded);

    expect(() => expectCiParity(mutatedSource)).toThrow(/Folded CI run blocks are not supported/u);
  });

  it("rejects continue-on-error on a deciding gate", () => {
    const source = readCiWorkflow();
    const original = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const continued = [
      "      - name: Check package architecture",
      "        continue-on-error: true",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const mutatedSource = replaceExactly(source, original, continued);

    expect(() => expectCiParity(mutatedSource)).toThrow(/must fail fast/u);
  });

  it("rejects unknown named and unnamed executable steps", () => {
    const source = readCiWorkflow();
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const unknownSteps = [
      [
        "      - name: Undeclared executable",
        "        run: echo unexpected",
      ].join("\n"),
      "      - run: echo unexpected",
    ];

    for (const unknownStep of unknownSteps) {
      const mutatedSource = replaceExactly(source, architecture, `${architecture}\n\n${unknownStep}`);
      expect(() => parseCiVerifyJob(mutatedSource)).toThrow(/Unclassified CI run step/u);
    }
  });

  it("rejects CI environment-step reordering", () => {
    const source = readCiWorkflow();
    const corepack = [
      "      - name: Enable Corepack",
      "        run: corepack enable",
    ].join("\n");
    const nodeCheck = [
      "      - name: Check Node support floor",
      "        run: pnpm run check:node",
    ].join("\n");
    const policy = [
      "      - name: Check pnpm release-age policy",
      "        run: node scripts/pnpm-release-age-policy.mjs",
    ].join("\n");
    const install = [
      "      - name: Install dependencies",
      "        run: pnpm install --frozen-lockfile",
    ].join("\n");
    const secrets = [
      "      - name: Check secrets",
      "        run: |",
      "          docker run --rm \\",
      "            -v \"$PWD:/repo\" \\",
      "            ghcr.io/gitleaks/gitleaks:v8.30.1 \\",
      "            dir --redact --no-banner --config /repo/.gitleaks.toml /repo",
    ].join("\n");
    const dependencyVulnerabilities = [
      "      - name: Check production dependency vulnerabilities",
      "        if: ${{ matrix.node-version == '22.19.0' }}",
      "        run: pnpm run check:dependency-vulnerabilities",
    ].join("\n");
    const releaseTag = [
      "      - name: Derive release smoke tag",
      "        id: release-smoke",
      "        run: |",
      "          set -euo pipefail",
      "          VERSION=\"$(node -e \"process.stdout.write(require('./packages/agent-app/package.json').version)\")\"",
      "          echo \"tag=v${VERSION}\" >> \"$GITHUB_OUTPUT\"",
    ].join("\n");
    const releaseValidate = [
      "      - name: Validate release package graph",
      `        run: pnpm run release:validate -- --tag "${CI_RELEASE_TAG_EXPRESSION}"`,
    ].join("\n");
    const gettingStartedPins = [
      "      - name: Check getting-started version pins",
      "        run: pnpm run check:getting-started-version-pins",
    ].join("\n");
    const docsQuality = [
      "      - name: Check documentation quality",
      "        run: pnpm run check:docs",
    ].join("\n");
    const mutations = [
      replaceExactly(
        source,
        `${corepack}\n\n${policy}\n\n${nodeCheck}`,
        `${nodeCheck}\n\n${policy}\n\n${corepack}`,
      ),
      replaceExactly(
        source,
        `${install}\n\n${dependencyVulnerabilities}\n\n${secrets}`,
        `${secrets}\n\n${dependencyVulnerabilities}\n\n${install}`,
      ),
      replaceExactly(
        source,
        `${releaseTag}\n\n${gettingStartedPins}\n\n${docsQuality}\n\n${releaseValidate}`,
        `${gettingStartedPins}\n\n${docsQuality}\n\n${releaseValidate}\n\n${releaseTag}`,
      ),
    ];

    for (const mutation of mutations) {
      expect(() => expectCiParity(mutation)).toThrow();
    }
  });

  it("rejects shell-source mutations that a lossy tokenizer could erase", () => {
    const source = readCiWorkflow();
    const gitCheck = "        run: git diff --check";
    const gitleaksFirstLine = "          docker run --rm \\";
    const gitleaksMount = "            -v \"$PWD:/repo\" \\";
    const mutations = [
      replaceExactly(source, gitCheck, ["        run: |", "          git", "          diff --check"].join("\n")),
      replaceExactly(source, gitleaksFirstLine, "          docker run --rm"),
      replaceExactly(source, gitCheck, "        run: git diff --check \"\""),
      replaceExactly(
        source,
        gitleaksMount,
        "            -v '$PWD:/repo' \\",
      ),
      replaceExactly(
        source,
        gitleaksMount,
        "            -v \"$PWD:/r\\epo\" \\",
      ),
    ];

    for (const mutation of mutations) {
      expect(() => expectCiParity(mutation)).toThrow();
    }
  });

  it("rejects action-input, condition, and release-tag sentinel collisions", () => {
    const source = readCiWorkflow();
    const matrixInput = "          node-version: \"${{ matrix.node-version }}\"";
    const architecture = [
      "      - name: Check package architecture",
      "        run: pnpm run check:architecture",
    ].join("\n");
    const releaseValidate = `        run: pnpm run release:validate -- --tag "${CI_RELEASE_TAG_EXPRESSION}"`;
    const mutations = [
      replaceExactly(source, matrixInput, `${matrixInput}\n          __proto__: poisoned`),
      replaceExactly(
        source,
        architecture,
        [
          "      - name: Check package architecture",
          "        if: always",
          "        run: pnpm run check:architecture",
        ].join("\n"),
      ),
      replaceExactly(
        source,
        releaseValidate,
        "        run: pnpm run release:validate -- --tag \"<release-tag>\"",
      ),
    ];

    for (const mutation of mutations) {
      expect(() => expectCiParity(mutation)).toThrow();
    }
  });

  it("rejects YAML version and tag directives", () => {
    const source = readCiWorkflow();
    const mutations = [
      `%YAML 1.1\n---\n${source}`,
      `%TAG !review! tag:review.invalid,2026:\n---\n${source}`,
    ];

    for (const mutation of mutations) {
      expect(() => parseCiVerifyJob(mutation)).toThrow(/directives are not allowed/u);
    }
  });

  it("rejects every noncanonical CI Node matrix value", () => {
    const source = readCiWorkflow();
    const matrix = "        node-version: [\"22.19.0\", \"24\"]";

    for (const replacement of ["20", "99", "future"]) {
      const mutation = replaceExactly(
        source,
        matrix,
        `        node-version: ["22.19.0", "${replacement}"]`,
      );
      expect(() => parseCiVerifyJob(mutation)).toThrow(/must remain exactly/u);
    }
  });
});

function expectCiParity(source) {
  const { steps: ciSteps, matrixVersions } = parseCiVerifyJob(source);
  const allDeltaEntries = [
    ...VERIFY_GATE_DELTA.ciSetup,
    ...VERIFY_GATE_DELTA.ciOnly,
    ...VERIFY_GATE_DELTA.verifyAllOnly,
    ...VERIFY_GATE_DELTA.commandDifferences,
    ...VERIFY_GATE_DELTA.relocatedCommandDifferences,
    ...VERIFY_GATE_DELTA.matrixDifferences,
  ];
  expect(allDeltaEntries.every((entry) => entry.reason.length > 0)).toBe(true);
  expect(matrixVersions).toEqual(EXPECTED_CI_NODE_MATRIX);

  expect(ciSteps
    .filter((step) => step.kind === "gate" && step.condition !== undefined)
    .map((step) => ({ label: step.label, condition: step.condition })))
    .toEqual(VERIFY_GATE_DELTA.matrixDifferences.map((entry) => ({
      label: entry.label,
      condition: entry.ciCondition,
    })));

  for (const nodeVersion of matrixVersions) {
    const actualCiSteps = projectCiSteps(ciSteps, nodeVersion);
    let expectedCiSteps = createRepoGate({
      releaseTag: CI_RELEASE_TAG_EXPRESSION,
      nodeVersion,
    }).map(toGateStep);

    for (const entry of VERIFY_GATE_DELTA.matrixDifferences) {
      if (nodeVersion !== entry.ciNodeVersion) {
        expectedCiSteps = removeExactGate(expectedCiSteps, entry.verifyAllOnlyGate, nodeVersion);
      }
    }

    for (const entry of VERIFY_GATE_DELTA.verifyAllOnly) {
      const gateIndexes = indexesOfStepKey(expectedCiSteps, entry.gate.label);
      const anchorIndexes = indexesOfStepKey(expectedCiSteps, entry.after);
      expect(gateIndexes, `verify-all-only ${entry.gate.label} on Node ${nodeVersion}`).toHaveLength(1);
      expect(anchorIndexes, `verify-all-only ${entry.gate.label} anchor on Node ${nodeVersion}`).toHaveLength(1);
      expect(gateIndexes[0], `verify-all-only ${entry.gate.label} position on Node ${nodeVersion}`)
        .toBe(anchorIndexes[0] + 1);
      expectedCiSteps = removeExactGate(expectedCiSteps, entry.gate, nodeVersion);
    }

    for (const entry of VERIFY_GATE_DELTA.ciOnly) {
      const anchorIndexes = indexesOfStepKey(expectedCiSteps, entry.after);
      expect(anchorIndexes, `CI-only ${entry.gate.label} anchor on Node ${nodeVersion}`).toHaveLength(1);
      expectedCiSteps.splice(anchorIndexes[0] + 1, 0, toGateStep(entry.gate));
    }

    for (const entry of VERIFY_GATE_DELTA.commandDifferences) {
      const indexes = indexesOfStepKey(expectedCiSteps, entry.label);
      expect(indexes, `command delta ${entry.label} on Node ${nodeVersion}`).toHaveLength(1);
      expect(expectedCiSteps[indexes[0]]).toEqual(toGateStep(entry.verifyAll));
      expectedCiSteps[indexes[0]] = toGateStep(entry.ci);
    }

    for (const entry of VERIFY_GATE_DELTA.relocatedCommandDifferences) {
      if (entry.ciNodeVersion !== undefined && nodeVersion !== entry.ciNodeVersion) {
        continue;
      }
      const gateIndexes = indexesOfStepKey(expectedCiSteps, entry.label);
      expect(gateIndexes, `relocated command delta ${entry.label} on Node ${nodeVersion}`).toHaveLength(1);
      expect(expectedCiSteps[gateIndexes[0]]).toEqual(toGateStep(entry.verifyAll));
      const verifyAllAnchorIndexes = indexesOfStepKey(expectedCiSteps, entry.verifyAllAfter);
      expect(verifyAllAnchorIndexes, `verify-all anchor for ${entry.label} on Node ${nodeVersion}`).toHaveLength(1);
      expect(gateIndexes[0], `verify-all position for ${entry.label} on Node ${nodeVersion}`)
        .toBe(verifyAllAnchorIndexes[0] + 1);
      expectedCiSteps.splice(gateIndexes[0], 1);
    }

    for (const entry of VERIFY_GATE_DELTA.ciSetup) {
      const setupStep = { kind: "setup", key: entry.key };
      if (entry.after === null) {
        expectedCiSteps.unshift(setupStep);
        continue;
      }
      const anchorIndexes = indexesOfStepKey(expectedCiSteps, entry.after);
      expect(anchorIndexes, `CI setup ${entry.key} anchor on Node ${nodeVersion}`).toHaveLength(1);
      expectedCiSteps.splice(anchorIndexes[0] + 1, 0, setupStep);
    }

    for (const entry of VERIFY_GATE_DELTA.relocatedCommandDifferences) {
      if (entry.ciNodeVersion !== undefined && nodeVersion !== entry.ciNodeVersion) {
        continue;
      }
      const ciAnchorIndexes = indexesOfStepKey(expectedCiSteps, entry.ciAfter);
      expect(ciAnchorIndexes, `CI anchor for ${entry.label} on Node ${nodeVersion}`).toHaveLength(1);
      expectedCiSteps.splice(ciAnchorIndexes[0] + 1, 0, toGateStep(entry.ci));
    }

    expect(actualCiSteps, `CI semantic step sequence for Node ${nodeVersion}`).toEqual(expectedCiSteps);
  }
}

function parseCiVerifyJob(source) {
  if (/^(?:\uFEFF)?%(?:YAML|TAG)\b/mu.test(source)) {
    throw new Error("YAML version and tag directives are not allowed in the CI parity contract.");
  }
  const document = parseDocument(source, {
    keepSourceTokens: true,
    merge: false,
    prettyErrors: false,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  const parseProblems = [...document.errors, ...document.warnings];
  if (parseProblems.length > 0) {
    throw new Error(`ci.yml must be strict YAML: ${parseProblems.map((problem) => problem.message).join("; ")}`);
  }
  const directiveTags = Object.entries(document.directives.tags);
  if (document.directives.yaml.explicit === true
    || directiveTags.length !== 1
    || directiveTags[0][0] !== "!!"
    || directiveTags[0][1] !== "tag:yaml.org,2002:") {
    throw new Error("YAML version and tag directives are not allowed in the CI parity contract.");
  }

  const root = requireYamlMap(document.contents, "ci.yml root");
  assertNoYamlIndirection(root, "ci.yml");
  const rootFields = readYamlMap(root, "ci.yml root");
  assertExactMapFields(rootFields, ["name", "on", "permissions", "concurrency", "jobs"], "CI workflow");
  const jobs = requireMapField(rootFields, "jobs", "ci.yml root");
  const jobFields = readYamlMap(jobs, "ci.yml jobs");
  assertExactMapFields(
    jobFields,
    ["verify", "website", "release-dry-run", "verdict"],
    "CI workflow jobs",
  );
  const verifyJob = requireMapField(jobFields, "verify", "ci.yml jobs");
  requireYamlMap(jobFields.get("website"), "ci.yml website job");
  requireYamlMap(jobFields.get("release-dry-run"), "ci.yml release-dry-run job");
  requireYamlMap(jobFields.get("verdict"), "ci.yml verdict job");

  const verifyFields = readYamlMap(verifyJob, "CI verify job");
  assertExactMapFields(
    verifyFields,
    ["name", "runs-on", "timeout-minutes", "strategy", "steps"],
    "CI verify job",
  );
  requireStringField(verifyFields, "name", "CI verify job");
  if (requireScalarField(verifyFields, "runs-on", "CI verify job") !== "ubuntu-latest") {
    throw new Error("The CI verify job must run on ubuntu-latest.");
  }
  if (requireScalarField(verifyFields, "timeout-minutes", "CI verify job") !== 60) {
    throw new Error("The CI verify job timeout must remain 60 minutes.");
  }

  const strategy = requireMapField(verifyFields, "strategy", "CI verify job");
  const strategyFields = readYamlMap(strategy, "CI verify strategy");
  assertExactMapFields(strategyFields, ["fail-fast", "matrix"], "CI verify strategy");
  if (requireScalarField(strategyFields, "fail-fast", "CI verify strategy") !== false) {
    throw new Error("The CI verify matrix must keep fail-fast disabled so every Node leg reports.");
  }
  const matrix = requireMapField(strategyFields, "matrix", "CI verify strategy");
  const matrixFields = readYamlMap(matrix, "CI verify matrix");
  assertExactMapFields(matrixFields, ["node-version"], "CI verify matrix");
  const nodeVersions = requireYamlSeq(matrixFields.get("node-version"), "CI Node matrix");
  const matrixVersions = nodeVersions.items.map((node, index) => (
    requireYamlString(node, `CI Node matrix item ${index + 1}`)
  ));
  if (JSON.stringify(matrixVersions) !== JSON.stringify(EXPECTED_CI_NODE_MATRIX)) {
    throw new Error(`The CI Node matrix must remain exactly ${JSON.stringify(EXPECTED_CI_NODE_MATRIX)}.`);
  }

  const steps = requireYamlSeq(verifyFields.get("steps"), "CI verify steps").items;
  if (steps.length === 0) {
    throw new Error("The CI verify job must contain at least one step.");
  }

  const parsedSteps = [];
  for (const [stepIndex, stepNode] of steps.entries()) {
    const step = requireYamlMap(stepNode, `CI verify step ${stepIndex + 1}`);
    const fields = readYamlMap(step, `CI verify step ${stepIndex + 1}`);
    const name = optionalStringField(fields, "name", `CI verify step ${stepIndex + 1}`) ?? "<unnamed>";
    const continueOnError = fields.get("continue-on-error");
    if (continueOnError !== undefined && (!isScalar(continueOnError) || continueOnError.value !== false)) {
      throw new Error(`CI step must fail fast: ${name}`);
    }

    const hasRun = fields.has("run");
    const hasUses = fields.has("uses");
    if (hasRun === hasUses) {
      throw new Error(`CI step must declare exactly one of run or uses: ${name}`);
    }

    if (hasUses) {
      assertOnlyStepFields(fields, USES_STEP_FIELDS, name);
      const uses = requireStringField(fields, "uses", `CI action step ${name}`);
      const actionStep = ACTION_STEPS.find((candidate) => candidate.uses === uses);
      if (actionStep === undefined) {
        throw new Error(`Unclassified CI action step: ${uses}`);
      }
      if (stepIndex !== actionStep.position) {
        throw new Error(`${actionStep.key} action must remain at verify-step position ${actionStep.position + 1}.`);
      }
      const condition = optionalStringField(fields, "if", `CI action step ${name}`);
      if (condition !== undefined) {
        throw new Error(`CI action condition drifted: ${actionStep.key}`);
      }
      const id = optionalStringField(fields, "id", `CI action step ${name}`);
      if (id !== actionStep.id) {
        throw new Error(`CI action id drifted: ${actionStep.key}`);
      }
      let withInputs;
      try {
        withInputs = parseWithInputs(fields.get("with"), name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`CI action inputs drifted: ${actionStep.key} (${reason})`);
      }
      if (!sameStringMap(withInputs, actionStep.withInputs)) {
        throw new Error(`CI action inputs drifted: ${actionStep.key}`);
      }
      parsedSteps.push({ kind: "setup", key: actionStep.key });
      continue;
    }

    assertOnlyStepFields(fields, RUN_STEP_FIELDS, name);
    const condition = optionalStringField(fields, "if", `CI run step ${name}`);
    const run = readRunCommand(fields.get("run"), name);
    const runContract = CI_RUN_STEP_CONTRACTS.find((candidate) => (
      candidate.command === run.command && candidate.style === run.style
    ));
    if (runContract === undefined) {
      throw new Error(`Unclassified CI run step: ${name}`);
    }
    if (runContract.kind === "setup") {
      if (condition !== undefined) {
        throw new Error(`Environment step condition drifted: ${name}`);
      }
      const id = optionalStringField(fields, "id", `CI environment step ${name}`);
      if (id !== runContract.id) {
        throw new Error(`Environment step id drifted: ${name}`);
      }
      parsedSteps.push({ kind: "setup", key: runContract.key });
      continue;
    }

    if (fields.has("id")) {
      throw new Error(`Gate step id drifted: ${name}`);
    }
    parsedSteps.push({ ...toGateStep(runContract.gate), condition });
  }

  return { steps: parsedSteps, matrixVersions };
}

const RUN_STEP_FIELDS = new Set(["name", "id", "if", "continue-on-error", "run"]);
const USES_STEP_FIELDS = new Set(["name", "id", "if", "continue-on-error", "uses", "with"]);

const ACTION_STEPS = Object.freeze([
  Object.freeze({
    key: "checkout",
    position: 0,
    uses: "actions/checkout@v4",
    withInputs: Object.freeze([]),
  }),
  Object.freeze({
    key: "Node setup",
    position: 1,
    uses: "actions/setup-node@v4",
    withInputs: Object.freeze([
      Object.freeze(["node-version", "${{ matrix.node-version }}"]),
    ]),
  }),
]);

const CI_RUN_STEP_CONTRACTS = Object.freeze([
  setupRunContract("corepack setup", "corepack enable"),
  gateRunContract("node scripts/pnpm-release-age-policy.mjs", {
    label: "check:pnpm-policy",
    command: "node",
    args: ["scripts/pnpm-release-age-policy.mjs"],
  }),
  gateRunContract("pnpm run check:node", {
    label: "check:node",
    command: "pnpm",
    args: ["run", "check:node"],
  }),
  setupRunContract("dependency install", "pnpm install --frozen-lockfile"),
  gateRunContract(literalScript([
    "docker run --rm \\",
    "  -v \"$PWD:/repo\" \\",
    "  ghcr.io/gitleaks/gitleaks:v8.30.1 \\",
    "  dir --redact --no-banner --config /repo/.gitleaks.toml /repo",
  ]), {
    label: "check:secrets",
    command: "docker",
    args: [
      "run",
      "--rm",
      "-v",
      "$PWD:/repo",
      "ghcr.io/gitleaks/gitleaks:v8.30.1",
      "dir",
      "--redact",
      "--no-banner",
      "--config",
      "/repo/.gitleaks.toml",
      "/repo",
    ],
  }, "literal"),
  gateRunContract("pnpm run check:oss-hygiene", {
    label: "check:oss-hygiene",
    command: "pnpm",
    args: ["run", "check:oss-hygiene"],
  }),
  gateRunContract("pnpm run check:licenses", {
    label: "check:licenses",
    command: "pnpm",
    args: ["run", "check:licenses"],
  }),
  gateRunContract("pnpm run check:dependency-vulnerabilities", {
    label: "check:dependency-vulnerabilities",
    command: "pnpm",
    args: ["run", "check:dependency-vulnerabilities"],
  }),
  gateRunContract("pnpm run check:codex-discoverability", {
    label: "check:codex-discoverability",
    command: "pnpm",
    args: ["run", "check:codex-discoverability"],
  }),
  gateRunContract("pnpm run check:consumer-docs-consistency", {
    label: "check:consumer-docs-consistency",
    command: "pnpm",
    args: ["run", "check:consumer-docs-consistency"],
  }),
  gateRunContract("pnpm run check:getting-started-version-pins", {
    label: "check:getting-started-version-pins",
    command: "pnpm",
    args: ["run", "check:getting-started-version-pins"],
  }),
  gateRunContract("pnpm run check:docs", {
    label: "check:docs",
    command: "pnpm",
    args: ["run", "check:docs"],
  }),
  setupRunContract("release-tag derivation", literalScript([
      "set -euo pipefail",
      "VERSION=\"$(node -e \"process.stdout.write(require('./packages/agent-app/package.json').version)\")\"",
      "echo \"tag=v${VERSION}\" >> \"$GITHUB_OUTPUT\"",
    ]), "literal", "release-smoke"),
  gateRunContract(`pnpm run release:validate -- --tag "${CI_RELEASE_TAG_EXPRESSION}"`, {
    label: "release:validate",
    command: "pnpm",
    args: ["run", "release:validate", "--", "--tag", CI_RELEASE_TAG_EXPRESSION],
  }),
  gateRunContract("pnpm run check:architecture", {
    label: "check:architecture",
    command: "pnpm",
    args: ["run", "check:architecture"],
  }),
  gateRunContract("pnpm run build", {
    label: "build",
    command: "pnpm",
    args: ["run", "build"],
  }),
  gateRunContract("pnpm run check:doc-snippets", {
    label: "check:doc-snippets",
    command: "pnpm",
    args: ["run", "check:doc-snippets"],
  }),
  gateRunContract("pnpm run check:deep-imports", {
    label: "check:deep-imports",
    command: "pnpm",
    args: ["run", "check:deep-imports"],
  }),
  gateRunContract("pnpm run verify:consumers --skip-build", {
    label: "verify:consumers",
    command: "pnpm",
    args: ["run", "verify:consumers", "--skip-build"],
  }),
  gateRunContract(`pnpm run release:pack -- --tag "${CI_RELEASE_TAG_EXPRESSION}"`, {
    label: "release:pack",
    command: "pnpm",
    args: ["run", "release:pack", "--", "--tag", CI_RELEASE_TAG_EXPRESSION],
  }),
  gateRunContract(`pnpm run release:consumer -- --tag "${CI_RELEASE_TAG_EXPRESSION}" --require-minimum`, {
    label: "release:consumer",
    command: "pnpm",
    args: ["run", "release:consumer", "--", "--tag", CI_RELEASE_TAG_EXPRESSION, "--require-minimum"],
  }),
  gateRunContract("pnpm run typecheck", {
    label: "typecheck",
    command: "pnpm",
    args: ["run", "typecheck"],
  }),
  gateRunContract("pnpm test", {
    label: "test",
    command: "pnpm",
    args: ["test"],
  }),
  gateRunContract("pnpm run build:demo", {
    label: "build:demo",
    command: "pnpm",
    args: ["run", "build:demo"],
  }),
  gateRunContract("pnpm run typecheck:demo", {
    label: "typecheck:demo",
    command: "pnpm",
    args: ["run", "typecheck:demo"],
  }),
  gateRunContract("pnpm run test:demo", {
    label: "test:demo",
    command: "pnpm",
    args: ["run", "test:demo"],
  }),
  gateRunContract("git diff --check", {
    label: "git diff --check",
    command: "git",
    args: ["diff", "--check"],
  }),
]);

function assertNoYamlIndirection(node, context) {
  if (node === null || node === undefined) {
    return;
  }
  if (isAlias(node)) {
    throw new Error(`YAML aliases are not allowed in the CI parity contract: ${context}`);
  }
  if (node.anchor !== undefined) {
    throw new Error(`YAML anchors are not allowed in the CI parity contract: ${context}`);
  }
  if (node.tag !== undefined) {
    throw new Error(`Explicit YAML tags are not allowed in the CI parity contract: ${context}`);
  }
  if (isScalar(node)) {
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        throw new Error(`YAML merge keys are not allowed in the CI parity contract: ${context}`);
      }
      assertNoYamlIndirection(pair.key, `${context} key`);
      assertNoYamlIndirection(pair.value, `${context}.${String(isScalar(pair.key) ? pair.key.value : "<key>")}`);
    }
    return;
  }
  if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      assertNoYamlIndirection(item, `${context}[${index}]`);
    }
    return;
  }
  throw new Error(`Unsupported YAML node in CI parity contract: ${context}`);
}

function requireYamlMap(node, context) {
  if (!isMap(node)) {
    throw new Error(`${context} must be a mapping.`);
  }
  return node;
}

function requireYamlSeq(node, context) {
  if (!isSeq(node)) {
    throw new Error(`${context} must be a sequence.`);
  }
  return node;
}

function requireYamlString(node, context) {
  if (!isScalar(node) || typeof node.value !== "string") {
    throw new Error(`${context} must be a string scalar.`);
  }
  return node.value;
}

function readYamlMap(node, context) {
  const fields = new Map();
  for (const pair of requireYamlMap(node, context).items) {
    const key = requireYamlString(pair.key, `${context} key`);
    if (key === "<<") {
      throw new Error(`YAML merge keys are not allowed in the CI parity contract: ${context}`);
    }
    if (fields.has(key)) {
      throw new Error(`Duplicate YAML field ${key}: ${context}`);
    }
    fields.set(key, pair.value);
  }
  return fields;
}

function requireMapField(fields, key, context) {
  return requireYamlMap(fields.get(key), `${context}.${key}`);
}

function requireScalarField(fields, key, context) {
  const node = fields.get(key);
  if (!isScalar(node)) {
    throw new Error(`${context}.${key} must be a scalar.`);
  }
  return node.value;
}

function requireStringField(fields, key, context) {
  return requireYamlString(fields.get(key), `${context}.${key}`);
}

function optionalStringField(fields, key, context) {
  return fields.has(key) ? requireStringField(fields, key, context) : undefined;
}

function assertExactMapFields(fields, expectedKeys, context) {
  const expected = new Set(expectedKeys);
  for (const key of fields.keys()) {
    if (!expected.has(key)) {
      throw new Error(`Unsupported ${context} field: ${key}`);
    }
  }
  for (const key of expected) {
    if (!fields.has(key)) {
      throw new Error(`Missing ${context} field: ${key}`);
    }
  }
}

function assertOnlyStepFields(fields, allowedFields, name) {
  for (const field of fields.keys()) {
    if (!allowedFields.has(field)) {
      throw new Error(`Unsupported execution field ${field} on CI step: ${name}`);
    }
  }
}

function parseWithInputs(withNode, name) {
  if (withNode === undefined) {
    return new Map();
  }
  const inputs = new Map();
  for (const [key, valueNode] of readYamlMap(withNode, `CI action inputs on ${name}`)) {
    inputs.set(key, requireYamlString(valueNode, `${key} on ${name}`));
  }
  return inputs;
}

function sameStringMap(left, rightEntries) {
  const leftEntries = [...left.entries()].sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const sortedRightEntries = [...rightEntries]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(sortedRightEntries);
}

function readRunCommand(runNode, name) {
  const command = requireYamlString(runNode, `run on ${name}`);
  if (runNode.type === Scalar.BLOCK_FOLDED) {
    throw new Error("Folded CI run blocks are not supported because they change shell command boundaries.");
  }
  if (command.length === 0) {
    throw new Error("CI run steps must contain a command.");
  }
  if (runNode.type === Scalar.BLOCK_LITERAL) {
    const header = runNode.srcToken?.type === "block-scalar"
      ? runNode.srcToken.props.find((token) => token.type === "block-scalar-header")?.source
      : undefined;
    if (header !== "|") {
      throw new Error(`Unsupported literal CI run-block modifier: ${header ?? "<unknown>"}`);
    }
    return { command, style: "literal" };
  }
  if (![Scalar.PLAIN, Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE].includes(runNode.type)) {
    throw new Error(`Unsupported CI run scalar style: ${runNode.type ?? "<unknown>"}`);
  }
  return { command, style: "scalar" };
}

function projectCiSteps(steps, nodeVersion) {
  const projected = [];
  for (const step of steps) {
    if (step.kind === "setup") {
      projected.push(step);
      continue;
    }

    if (step.condition === undefined) {
      projected.push(toGateStep(step));
      continue;
    }

    const delta = VERIFY_GATE_DELTA.matrixDifferences.find((entry) => entry.label === step.label);
    if (delta === undefined || step.condition !== delta.ciCondition) {
      throw new Error(`Undocumented CI condition for ${step.label}: ${step.condition}`);
    }
    if (nodeVersion === delta.ciNodeVersion) {
      projected.push(toGateStep(step));
    }
  }
  return projected;
}

function removeExactGate(gates, expectedGate, nodeVersion) {
  const normalizedExpected = toGateStep(expectedGate);
  const indexes = gates
    .map((gate, index) => sameGate(gate, normalizedExpected) ? index : -1)
    .filter((index) => index >= 0);
  expect(indexes, `verify-all-only ${expectedGate.label} on Node ${nodeVersion}`).toHaveLength(1);
  return gates.filter((_gate, index) => index !== indexes[0]);
}

function indexesOfStepKey(steps, key) {
  return steps
    .map((step, index) => (step.kind === "setup" ? step.key : step.label) === key ? index : -1)
    .filter((index) => index >= 0);
}

function sameGate(left, right) {
  return left.label === right.label
    && left.command === right.command
    && JSON.stringify(left.args) === JSON.stringify(right.args);
}

function toGateStep(gate) {
  return {
    kind: "gate",
    label: gate.label,
    command: gate.command,
    args: [...gate.args],
  };
}

function literalScript(lines) {
  return `${lines.join("\n")}\n`;
}

function setupRunContract(key, command, style = "scalar", id = undefined) {
  return Object.freeze({ kind: "setup", key, command, style, id });
}

function gateRunContract(command, gate, style = "scalar") {
  return Object.freeze({
    kind: "gate",
    command,
    style,
    gate: Object.freeze({
      label: gate.label,
      command: gate.command,
      args: Object.freeze([...gate.args]),
    }),
  });
}

function replaceExactly(source, original, replacement) {
  expect(source.split(original), `mutation fixture: ${original}`).toHaveLength(2);
  return source.replace(original, replacement);
}

function readCiWorkflow() {
  return readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
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
