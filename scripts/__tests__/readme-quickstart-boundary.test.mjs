// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  packageCatalog,
  packageRelativePath,
} from "../lib/package-catalog.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readRepoFile(relativePath) {
  return readFileSync(new URL(relativePath, `file://${repoRoot}/`), "utf8");
}

function topLevelSection(page, heading) {
  const marker = `## ${heading}`;
  const start = page.indexOf(marker);
  if (start === -1) throw new Error(`missing README section: ${heading}`);

  const rest = page.slice(start + marker.length);
  const next = rest.search(/\n## /u);
  return next === -1 ? rest : rest.slice(0, next);
}

const registryCommandPatterns = [
  /\bnpm\s+create\s+mono-agent\b/iu,
  /\bnpx\s+(?:-y\s+)?["']?(?:@mono-agent\/|create-mono-agent\b)/iu,
  /\bnpm\s+(?:i|install)\s+(?:--global\s+|-g\s+)?(?:@mono-agent\/|create-mono-agent\b)/iu,
  /\bpnpm\s+add\s+(?:--global\s+|-g\s+)?@mono-agent\//iu,
];
const bareExecutablePatterns = [
  /(?:^|\n)\s*mono-agent(?:\s|$)/mu,
  /(?:^|\n)\s*mono-agent-memory-local(?:\s|$)/mu,
  /(?:^|\n)\s*mono-agent-service-macos(?:\s|$)/mu,
  /(?:^|\n)\s*mono-agent-web(?:\s|$)/mu,
];

describe("source-only newcomer boundary", () => {
  const readme = readRepoFile("README.md");
  const quickstart = topLevelSection(
    readme,
    "Source quickstart",
  );

  it("keeps the supported source flow complete and ordered", () => {
    const commands = [
      "git clone https://github.com/robertsreberski/mono-agent-next.git",
      "cd mono-agent-next",
      "corepack enable",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "node packages/create-mono-agent/dist/bin/create-mono-agent.js",
      "--template minimal",
      "pnpm run verify:minimal",
    ];

    let cursor = -1;
    for (const command of commands) {
      const next = quickstart.indexOf(command, cursor + 1);
      expect(next, `Quickstart is missing the ordered command: ${command}`).toBeGreaterThan(cursor);
      cursor = next;
    }

    expect(quickstart).toContain("not published to npm");
    expect(quickstart).toContain("cannot be installed from npm");
  });

  it("does not advertise an unavailable registry path", () => {
    for (const pattern of registryCommandPatterns) {
      expect(quickstart).not.toMatch(pattern);
    }
  });

  it("states the same boundary in canonical newcomer docs and scaffolder docs", () => {
    const install = readRepoFile("docs/getting-started/install.md");
    const firstAgent = readRepoFile("docs/getting-started/quickstart.md");
    const scaffolder = readRepoFile("packages/create-mono-agent/README.md");
    const scaffoldTemplates = readRepoFile("packages/create-mono-agent/src/templates.ts");
    const scaffoldCli = readRepoFile("packages/create-mono-agent/src/cli.ts");

    expect(install).toContain("Registry installation remains a later phase");
    expect(install).toContain("Install a retained minimal local-tarball consumer");
    expect(firstAgent).toContain("not published to npm");
    expect(firstAgent).toContain("packages/create-mono-agent/dist/bin/create-mono-agent.js");
    expect(scaffolder).toContain("not published during the source preview");
    expect(scaffolder).toContain("For the default minimal template only");
    expect(scaffolder).toContain("Personal and multi-runtime remain render-and-validate only");
    expect(scaffolder).not.toContain("npm create mono-agent@0.15.0");
    expect(scaffolder).not.toContain("npm install --global create-mono-agent@0.15.0");
    for (const [path, source] of [
      ["packages/create-mono-agent/src/templates.ts", scaffoldTemplates],
      ["packages/create-mono-agent/src/cli.ts", scaffoldCli],
    ]) {
      expect(source, `${path} must forbid installing unpublished pins`).toMatch(
        /Do not (?:pass `|use )--install/u,
      );
      expect(source, `${path} must name the canonical post-render guide`).toContain(
        "docs/getting-started/install.md",
      );
      expect(source, `${path} must name only the bounded source-preview escape`).toContain(
        "source-preview",
      );
      expect(source, `${path} must name only the bounded source-preview escape`).toContain(
        "local-tarball flow",
      );
    }
  });

  it("keeps every package README off predecessor registry entry points", () => {
    for (const entry of packageCatalog) {
      const path = `${packageRelativePath(entry)}/README.md`;
      const page = readRepoFile(path);
      expect(page, `${path} must identify colliding registry artifacts`).toMatch(
        /predecessor\s+repository/u,
      );
      for (const pattern of registryCommandPatterns) {
        expect(page, `${path} must not advertise ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps canonical source-preview docs and scaffolder help off registry entry points", () => {
    for (const path of [
      "README.md",
      "docs/getting-started/install.md",
      "docs/getting-started/quickstart.md",
      "packages/create-mono-agent/README.md",
      "packages/create-mono-agent/src/cli.ts",
      "packages/create-mono-agent/src/templates.ts",
    ]) {
      const page = readRepoFile(path);
      for (const pattern of registryCommandPatterns) {
        expect(page, `${path} must not advertise ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("renders into a canonical temporary parent instead of a symlinked platform alias", () => {
    for (const path of [
      "README.md",
      "docs/getting-started/install.md",
      "docs/getting-started/quickstart.md",
      "packages/create-mono-agent/README.md",
    ]) {
      const page = readRepoFile(path);
      expect(page, `${path} must create a unique temporary parent`).toContain("mktemp -d");
      expect(page, `${path} must canonicalize the temporary parent`).toContain("pwd -P");
      expect(page, `${path} must not use the macOS /tmp symlink`).not.toMatch(/\/tmp\//u);
    }
  });

  it("uses exact built entrypoints instead of shadowable global binaries", () => {
    const expectedEntrypoints = new Map([
      ["README.md", "node packages/cli/dist/bin/mono-agent.js"],
      [
        "docs/getting-started/quickstart.md",
        "node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js",
      ],
      [
        "docs/config/index.md",
        "node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js",
      ],
      [
        "docs/config/reference.md",
        "node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js",
      ],
      ["docs/observability/web-console.md", "node packages/web/dist/bin.js"],
      ["docs/reference/architecture.md", "node packages/cli/dist/bin/mono-agent.js"],
      [
        "packages/memory-local/README.md",
        "node packages/memory-local/dist/bin/memory-local.js",
      ],
      ["packages/runtime-pi/README.md", "node packages/cli/dist/bin/mono-agent.js"],
      ["packages/sandbox-srt/README.md", "node packages/cli/dist/bin/mono-agent.js"],
      [
        "packages/service-macos/README.md",
        "node packages/service-macos/dist/bin/service-macos.js",
      ],
      [
        "packages/create-mono-agent/skills/mono-agent-composer/SKILL.md",
        "node packages/create-mono-agent/dist/bin/create-mono-agent.js",
      ],
      [
        "packages/create-mono-agent/skills/mono-agent-composer/references/validation.md",
        "node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js",
      ],
      [
        "SECURITY.md",
        "node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js",
      ],
    ]);

    for (const [path, entrypoint] of expectedEntrypoints) {
      const page = readRepoFile(path);
      expect(page, `${path} must use ${entrypoint}`).toContain(entrypoint);
      for (const pattern of bareExecutablePatterns) {
        expect(page, `${path} must not advertise ${String(pattern)}`).not.toMatch(pattern);
      }
      expect(page, `${path} must not invoke an ambient mono-agent binary`).not.toMatch(
        /\bmono-agent\s+(?:auth|config|init|inspect|module|sandbox|start|validate)\b/iu,
      );
    }
  });
});
