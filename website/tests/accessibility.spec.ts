// SPDX-License-Identifier: MIT
import { existsSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const DIST_DIRECTORY = fileURLToPath(new URL("../dist/", import.meta.url));
const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

function collectHtmlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? collectHtmlFiles(path)
      : extname(entry.name) === ".html"
        ? [path]
        : [];
  });
}

function routeForHtmlFile(path: string): string {
  const outputPath = relative(DIST_DIRECTORY, path).split(sep).join("/");
  if (outputPath === "index.html") return "/";
  if (outputPath.endsWith("/index.html")) {
    return `/${outputPath.slice(0, -"index.html".length)}`;
  }
  return `/${outputPath}`;
}

function builtRoutes(): string[] {
  if (!existsSync(DIST_DIRECTORY)) {
    throw new Error(
      "website/dist is missing. Run `pnpm run build` before `pnpm run test:a11y`.",
    );
  }

  const routes = collectHtmlFiles(DIST_DIRECTORY).map(routeForHtmlFile).sort();
  if (routes.length === 0) {
    throw new Error("website/dist contains no HTML routes to audit.");
  }
  return routes;
}

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"],
): string {
  return JSON.stringify(
    violations.map(({ help, helpUrl, id, impact, nodes }) => ({
      help,
      helpUrl,
      id,
      impact,
      nodes: nodes.map(({ failureSummary, target }) => ({
        failureSummary,
        target,
      })),
    })),
    null,
    2,
  );
}

test.describe("built documentation accessibility", () => {
  for (const route of builtRoutes()) {
    test(`${route} has no WCAG A/AA violations`, async ({ page }) => {
      const response = await page.goto(route, { waitUntil: "networkidle" });
      expect(response, `No document response for ${route}`).not.toBeNull();
      expect(response?.ok(), `Failed to load ${route}`).toBe(true);

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      if (results.violations.length > 0) {
        throw new Error(
          `Accessibility violations for ${route}:\n${formatViolations(results.violations)}`,
        );
      }
    });
  }
});
