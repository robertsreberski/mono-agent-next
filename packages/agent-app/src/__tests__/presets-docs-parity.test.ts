import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  composeWizardPlan,
  findPreset,
  PRESET_CATALOG,
  presetAnswers,
  presetIds,
} from "../wizard/index.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this test until the pnpm workspace root (the dir with pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

/** The body between a `## <heading>` line and the next `## ` heading (or EOF). */
function section(page: string, heading: string): string {
  const start = page.indexOf(`## ${heading}`);
  if (start === -1) {
    throw new Error(`docs/reference/presets.md is missing the "## ${heading}" section`);
  }
  const rest = page.slice(start + `## ${heading}`.length);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * docs/reference/presets.md is the human-facing catalog of the wizard presets and
 * capability modules. Adding a preset without its row in the Presets table fails
 * here — the same contract the env-vars/feature-registry parity tests enforce.
 */
describe("presets docs parity", () => {
  const page = readFileSync(join(repoRoot(), "docs/reference/presets.md"), "utf8");
  const presetsTable = section(page, "Presets");

  it("documents every preset id in the Presets table", () => {
    for (const id of presetIds()) {
      expect(presetsTable, `docs/reference/presets.md Presets table is missing preset \`${id}\``).toContain(
        `| \`${id}\` |`,
      );
    }
  });

  it("does not document preset ids that no longer exist", () => {
    const documented = [...presetsTable.matchAll(/^\| `([a-z0-9-]+)` \|/gmu)].map((match) => match[1]);
    expect(documented.length).toBeGreaterThan(0);
    const known = new Set(presetIds());
    for (const id of documented) {
      expect(known, `docs/reference/presets.md documents unknown preset \`${id}\``).toContain(id);
    }
  });

  it("points every preset playbook at an existing docs/playbooks file", () => {
    for (const preset of PRESET_CATALOG) {
      if (preset.playbook === undefined) {
        continue;
      }
      const path = join(repoRoot(), "docs/playbooks", preset.playbook);
      expect(existsSync(path), `preset \`${preset.id}\` references a missing playbook docs/playbooks/${preset.playbook}`).toBe(
        true,
      );
    }
  });

  it("keeps the sandboxed-code playbook JSON aligned with the code-sandbox preset", () => {
    const preset = findPreset("code-sandbox");
    if (preset === undefined) {
      throw new Error("code-sandbox preset not found");
    }
    const config = composeWizardPlan(presetAnswers(preset), { dirBasename: "x", skillsRootExists: false }).configJson;
    const playbook = readFileSync(join(repoRoot(), "docs/playbooks/sandboxed-code-agent.md"), "utf8");
    const snippet = parseJsonBlock(playbook) as {
      readonly tools?: { readonly allowedTools?: readonly string[] };
      readonly sandbox?: {
        readonly mode?: string;
        readonly network?: { readonly mode?: string };
        readonly readableRoots?: readonly string[];
        readonly writableRoots?: readonly string[];
        readonly fallback?: string;
      };
    };

    expect(snippet.tools?.allowedTools).toEqual(config.tools?.allowedTools);
    expect(snippet.sandbox).toMatchObject({
      mode: config.sandbox?.mode,
      network: config.sandbox?.network,
      readableRoots: config.sandbox?.readableRoots,
      writableRoots: config.sandbox?.writableRoots,
      fallback: config.sandbox?.fallback,
    });
  });
});

function parseJsonBlock(markdown: string): unknown {
  const match = markdown.match(/```json\n([\s\S]*?)\n```/u);
  if (match === null) {
    throw new Error("markdown page has no json code block");
  }
  return JSON.parse(match[1] ?? "");
}
