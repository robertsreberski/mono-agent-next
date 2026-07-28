// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  PERSONAL_SUCCESSOR_DEPENDENCIES,
  PERSONAL_SUCCESSOR_EXCLUDED_PACKAGES,
  assertPersonalSuccessorBlueprint,
  readPersonalSuccessorBlueprint,
  renderPersonalSuccessorProducts,
} from "../lib/personal-successor.mjs";
import {
  parsePersonalSuccessorArgs,
  personalSuccessorCommands,
  runPersonalSuccessorProof,
} from "../verify/personal-successor.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("personal successor blueprint", () => {
  it("pins the exact clean-room package and product boundary", () => {
    const loaded = readPersonalSuccessorBlueprint(root);
    const blueprint = assertPersonalSuccessorBlueprint(loaded.blueprint, "0.15.0");
    expect(blueprint.directDependencies).toEqual(PERSONAL_SUCCESSOR_DEPENDENCIES);
    expect(blueprint.excludedPackages).toEqual(PERSONAL_SUCCESSOR_EXCLUDED_PACKAGES);
    expect(blueprint.directDependencies).not.toContain("@mono-agent/channel-slack");
    expect(blueprint.directDependencies).not.toContain("@mono-agent/sandbox-srt");
    expect(blueprint.products).toEqual({
      agent: "mono-agent.config.json",
      docsMcp: "node_modules/.bin/mono-agent-docs-mcp",
      serviceMacosTemplate: "service-macos.template.json",
      tui: "node_modules/.bin/mono-agent-tui",
      web: "web.config.json",
    });
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects package, version, and proof drift", () => {
    const loaded = readPersonalSuccessorBlueprint(root);
    expect(() => assertPersonalSuccessorBlueprint({
      ...loaded.blueprint,
      directDependencies: loaded.blueprint.directDependencies.slice(1),
    }, "0.15.0")).toThrow(/dependency roster drifted/u);
    expect(() => assertPersonalSuccessorBlueprint(loaded.blueprint, "0.16.0"))
      .toThrow(/package version/u);
    expect(() => assertPersonalSuccessorBlueprint({
      ...loaded.blueprint,
      proofs: { ...loaded.blueprint.proofs, browser: "source inspection" },
    }, "0.15.0")).toThrow(/proof map drifted/u);
  });

  it("renders only loopback products and canonical absolute service targets", () => {
    const loaded = readPersonalSuccessorBlueprint(root);
    const rendered = renderPersonalSuccessorProducts(
      loaded.fixtureRoot,
      "/example/personal-agent-next",
    );
    const web = JSON.parse(rendered["web.config.json"]);
    const service = JSON.parse(rendered["service-macos.json"]);
    expect(web.listen).toEqual({ host: "127.0.0.1", port: 0 });
    expect(web.auth).toEqual({ token: { $env: "MONO_AGENT_WEB_TOKEN" } });
    expect(service.services["personal-agent-next"]).toMatchObject({
      target: {
        kind: "agent",
        config: "/example/personal-agent-next/mono-agent.config.json",
      },
      startAtLogin: false,
    });
    expect(service.services["personal-agent-next-web"]).toMatchObject({
      target: {
        kind: "web",
        config: "/example/personal-agent-next/web.config.json",
      },
      startAtLogin: false,
    });
    expect(JSON.stringify(service)).not.toContain("__PROJECT_ROOT__");
  });

  it("runs the exact packed, operator, and fake-service proof sequence", async () => {
    expect(personalSuccessorCommands()).toEqual([
      {
        label: "packed-system",
        command: "pnpm",
        args: ["run", "verify:system"],
      },
      {
        label: "operator-products",
        command: "pnpm",
        args: ["run", "verify:operator-products"],
      },
      {
        label: "service-lifecycle",
        command: "pnpm",
        args: ["--filter", "@mono-agent/service-macos", "test"],
      },
    ]);
    const stdout = sink();
    const called = [];
    const result = await runPersonalSuccessorProof({
      argv: [],
      cwd: root,
      nodeVersion: "22.19.0",
      captureSource: () => ({ commitSha: "a".repeat(40), clean: true }),
      stdout,
      stderr: sink(),
      runCommand: async (_command, _args, options) => {
        called.push(options.label);
        return 0;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(called).toEqual(["packed-system", "operator-products", "service-lifecycle"]);
    expect(stdout.text).toContain('"browserNode":"22.19.0"');
    expect(stdout.text).toContain('"externalNetworkServices":0');
  });

  it("supports only the explicit contract-only mode", () => {
    expect(parsePersonalSuccessorArgs([])).toEqual({ contractOnly: false });
    expect(parsePersonalSuccessorArgs(["--contract-only"])).toEqual({
      contractOnly: true,
    });
    expect(parsePersonalSuccessorArgs(["--", "--contract-only"])).toEqual({
      contractOnly: true,
    });
    expect(() => parsePersonalSuccessorArgs(["--skip-runtime"])).toThrow(/Unknown argument/u);
  });

  it("runs the successor gate on both Node lanes and the browser only on Node 22", () => {
    const source = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const workflow = parseDocument(source, {
      merge: false,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    }).toJS({ mapAsMap: false });
    const steps = workflow.jobs.verify.steps;
    expect(steps.filter((step) => step.run === "pnpm run verify:personal-successor"))
      .toEqual([{
        name: "Prove clean-room personal successor",
        run: "pnpm run verify:personal-successor",
      }]);
    expect(steps.filter((step) => step.run === "pnpm run test:browser"))
      .toEqual([{
        name: "Prove the console renders in a real browser",
        if: "${{ matrix.node-version == '22.19.0' }}",
        run: "pnpm run test:browser",
      }]);
    expect(steps.some((step) => step.run === "pnpm run verify:system")).toBe(false);
  });
});

function sink() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
      return true;
    },
  };
}
