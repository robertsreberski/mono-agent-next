import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export const PUBLIC_API_INVENTORY_START = "<!-- public-api-inventory:start -->";
export const PUBLIC_API_INVENTORY_END = "<!-- public-api-inventory:end -->";
export const JS_SUBPATH_INVENTORY_START = "<!-- public-api-js-subpaths:start -->";
export const JS_SUBPATH_INVENTORY_END = "<!-- public-api-js-subpaths:end -->";

const MODULE_EXTENSION_PATTERN = /(?:\.d)?\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/u;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Derive every public package entrypoint and exported symbol from package.json
 * export maps and the corresponding source entrypoints.
 *
 * @param {{ root: string, catalog: readonly object[] }} input
 */
export function collectPackagePublicApiInventories({ root, catalog }) {
  const definitions = [];
  const errors = [];

  for (const catalogEntry of catalog) {
    const packagePath = packageRelativePath(catalogEntry);
    const packageDir = join(root, packagePath);
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) {
      errors.push(`${packagePath}/package.json is missing.`);
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entrypoints = [];
    for (const [subpath, target] of codeExportEntries(manifest.exports)) {
      const targets = flattenExportTargets(target).filter(isModuleTarget);
      if (targets.length === 0) {
        continue;
      }

      const sourcePaths = new Set();
      for (const targetPath of targets) {
        if (targetPath.includes("*")) {
          errors.push(`${packagePath}/package.json export ${subpath} uses unsupported wildcard target ${targetPath}.`);
          continue;
        }
        for (const sourcePath of sourceCandidates(packageDir, targetPath)) {
          sourcePaths.add(sourcePath);
        }
      }

      if (sourcePaths.size === 0) {
        errors.push(
          `${packagePath}/package.json export ${subpath} has no source entrypoint for ${targets.join(", ")}.`,
        );
        continue;
      }

      entrypoints.push({
        subpath,
        sourcePaths: [...sourcePaths].sort(compareText),
      });
    }

    definitions.push({
      packageName: manifest.name,
      packagePath,
      manifest,
      entrypoints: entrypoints.sort((left, right) => compareSubpaths(left.subpath, right.subpath)),
    });
  }

  const rootNames = [...new Set(
    definitions.flatMap((definition) => definition.entrypoints.flatMap((entrypoint) => entrypoint.sourcePaths)),
  )];
  const program = ts.createProgram({
    rootNames,
    options: {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    },
  });
  const checker = program.getTypeChecker();

  const inventories = definitions.map((definition) => ({
    packageName: definition.packageName,
    packagePath: definition.packagePath,
    manifest: definition.manifest,
    entrypoints: definition.entrypoints.map((entrypoint) => {
      const exportNames = new Set();
      for (const sourcePath of entrypoint.sourcePaths) {
        const sourceFile = program.getSourceFile(sourcePath);
        if (sourceFile === undefined) {
          errors.push(
            `${definition.packagePath} export ${entrypoint.subpath} source ${relative(root, sourcePath)} was not loaded by TypeScript.`,
          );
          continue;
        }
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
        if (moduleSymbol === undefined) {
          errors.push(
            `${definition.packagePath} export ${entrypoint.subpath} source ${relative(root, sourcePath)} is not a module.`,
          );
          continue;
        }
        for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
          exportNames.add(exportedSymbol.name);
        }
      }
      return {
        subpath: entrypoint.subpath,
        exportNames: [...exportNames].sort(compareText),
      };
    }),
  }));

  return { inventories, errors };
}

/**
 * Validate catalog README inventories and any classified MIGRATION subpath
 * inventories. Narrative prose and examples outside the generated markers are
 * deliberately ignored.
 *
 * @param {{ root: string, catalog: readonly object[] }} input
 */
export function findPackagePublicApiDocErrors({ root, catalog }) {
  const { inventories, errors } = collectPackagePublicApiInventories({ root, catalog });

  for (const inventory of inventories) {
    const readmePath = join(root, inventory.packagePath, "README.md");
    if (!existsSync(readmePath)) {
      continue;
    }
    const readme = readFileSync(readmePath, "utf8");
    const expected = renderPublicApiInventory(inventory);
    const actual = markedBlock(readme, PUBLIC_API_INVENTORY_START, PUBLIC_API_INVENTORY_END);
    const section = markdownSection(readme, "## Public API");

    if (section === undefined) {
      errors.push(`${inventory.packagePath}/README.md is missing its Public API section.`);
    } else if (actual === undefined || !section.text.includes(actual)) {
      errors.push(
        `${inventory.packagePath}/README.md is missing the generated Public API inventory inside its Public API section.`,
      );
    } else if (actual !== expected) {
      errors.push(
        `${inventory.packagePath}/README.md Public API inventory has drifted from package.json and source exports; run pnpm run generate:public-api-docs.`,
      );
    }

    const staleFieldGroups = [...readme.matchAll(/\b[A-Za-z_$][\w$]*FieldGroup\b/gu)].map((match) => match[0]);
    if (staleFieldGroups.length > 0) {
      errors.push(
        `${inventory.packagePath}/README.md references stale FieldGroup identifier(s): ${[...new Set(staleFieldGroups)].join(", ")}.`,
      );
    }

    const migrationPath = join(root, inventory.packagePath, "MIGRATION.md");
    if (!existsSync(migrationPath)) {
      continue;
    }
    const migration = readFileSync(migrationPath, "utf8");
    const actualSubpaths = markedBlock(migration, JS_SUBPATH_INVENTORY_START, JS_SUBPATH_INVENTORY_END);
    const deepJsSubpaths = codeExportEntries(inventory.manifest.exports)
      .map(([subpath]) => subpath)
      .filter((subpath) => subpath.startsWith("./") && subpath.endsWith(".js"));
    if (actualSubpaths === undefined && deepJsSubpaths.length > 0) {
      errors.push(
        `${inventory.packagePath}/MIGRATION.md is missing its generated deep .js subpath inventory.`,
      );
      continue;
    }
    if (actualSubpaths === undefined) {
      continue;
    }
    const expectedSubpaths = renderJsSubpathInventory(inventory);
    if (actualSubpaths !== expectedSubpaths) {
      errors.push(
        `${inventory.packagePath}/MIGRATION.md deep .js subpath inventory has drifted from package.json; run pnpm run generate:public-api-docs.`,
      );
    }
  }

  return errors;
}

export function renderPublicApiInventory({ packageName, entrypoints }) {
  const lines = [
    PUBLIC_API_INVENTORY_START,
    "<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->",
  ];

  if (entrypoints.length === 0) {
    lines.push("", "Library exports: none (this package has no code export map).", PUBLIC_API_INVENTORY_END);
    return lines.join("\n");
  }

  lines.push("", "Every symbol exported by each public code entrypoint is listed below.");
  for (const entrypoint of entrypoints) {
    const specifier = packageSpecifier(packageName, entrypoint.subpath);
    lines.push("", `**\`${specifier}\`**`, "", "```text");
    if (entrypoint.exportNames.length === 0) {
      lines.push("(no named exports)");
    } else {
      lines.push(...entrypoint.exportNames);
    }
    lines.push("```");
  }
  lines.push("", PUBLIC_API_INVENTORY_END);
  return lines.join("\n");
}

export function renderJsSubpathInventory({ packageName, manifest }) {
  const subpaths = codeExportEntries(manifest.exports)
    .map(([subpath]) => subpath)
    .filter((subpath) => subpath.startsWith("./") && subpath.endsWith(".js"))
    .sort(compareText);
  const noun = subpaths.length === 1 ? "subpath" : "subpaths";
  const lines = [
    JS_SUBPATH_INVENTORY_START,
    "<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->",
    "",
    `The package exposes **${subpaths.length} named deep \`.js\` ${noun}**:`,
    "",
    "```text",
    ...subpaths.map((subpath) => packageSpecifier(packageName, subpath)),
    "```",
    JS_SUBPATH_INVENTORY_END,
  ];
  return lines.join("\n");
}

export function updateReadmePublicApiInventory(readme, renderedInventory) {
  const existing = markedBlock(readme, PUBLIC_API_INVENTORY_START, PUBLIC_API_INVENTORY_END);
  if (existing !== undefined) {
    return normalizeSectionSpacing(readme.replace(existing, renderedInventory), "## Public API");
  }

  const section = markdownSection(readme, "## Public API");
  if (section === undefined) {
    throw new Error("README is missing a ## Public API section.");
  }

  const headingEnd = section.start + "## Public API".length;
  const body = readme.slice(headingEnd, section.end);
  const preserved = stripLeadingApiList(body);
  const replacement = `\n\n${renderedInventory}${preserved.length > 0 ? `\n\n${preserved}` : ""}\n\n`;
  return normalizeSectionSpacing(
    `${readme.slice(0, headingEnd)}${replacement}${readme.slice(section.end)}`,
    "## Public API",
  );
}

export function updateMigrationJsSubpathInventory(migration, renderedInventory) {
  const existing = markedBlock(migration, JS_SUBPATH_INVENTORY_START, JS_SUBPATH_INVENTORY_END);
  if (existing === undefined) {
    return migration;
  }
  return migration.replace(existing, renderedInventory);
}

function codeExportEntries(exportsField) {
  if (exportsField === undefined || exportsField === null) {
    return [];
  }
  if (typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return [[".", exportsField]];
  }
  const entries = Object.entries(exportsField);
  if (!entries.some(([key]) => key.startsWith("."))) {
    return [[".", exportsField]];
  }
  return entries.filter(([key]) => key === "." || key.startsWith("./"));
}

function flattenExportTargets(target) {
  if (typeof target === "string") {
    return [target];
  }
  if (Array.isArray(target)) {
    return target.flatMap(flattenExportTargets);
  }
  if (target !== null && typeof target === "object") {
    return Object.values(target).flatMap(flattenExportTargets);
  }
  return [];
}

function isModuleTarget(target) {
  return MODULE_EXTENSION_PATTERN.test(target);
}

function sourceCandidates(packageDir, target) {
  if (!target.startsWith("./")) {
    return [];
  }

  const directPath = resolve(packageDir, target);
  if (target.startsWith("./src/") || target.startsWith("./types/")) {
    return existsSync(directPath) ? [directPath] : [];
  }
  if (!target.startsWith("./dist/")) {
    return existsSync(directPath) ? [directPath] : [];
  }

  const relativeOutputPath = target.slice("./dist/".length);
  const sourceStem = stripModuleExtension(relativeOutputPath);
  const candidates = SOURCE_EXTENSIONS.map((extension) => join(packageDir, "src", `${sourceStem}${extension}`));
  return candidates.filter(existsSync);
}

function stripModuleExtension(path) {
  return path.replace(MODULE_EXTENSION_PATTERN, "");
}

function markedBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    return undefined;
  }
  const duplicateStart = text.indexOf(startMarker, start + startMarker.length);
  const end = text.indexOf(endMarker, start + startMarker.length);
  const duplicateEnd = end === -1 ? -1 : text.indexOf(endMarker, end + endMarker.length);
  if (duplicateStart !== -1 || end === -1 || duplicateEnd !== -1) {
    return undefined;
  }
  return text.slice(start, end + endMarker.length);
}

function markdownSection(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) {
    return undefined;
  }
  const nextHeading = text.indexOf("\n## ", start + heading.length);
  const end = nextHeading === -1 ? text.length : nextHeading + 1;
  return { start, end, text: text.slice(start, end) };
}

function normalizeSectionSpacing(text, heading) {
  const section = markdownSection(text, heading);
  if (section === undefined) {
    return text;
  }
  if (section.end === text.length) {
    return `${text.trimEnd()}\n`;
  }
  return `${text.slice(0, section.end).trimEnd()}\n\n${text.slice(section.end)}`;
}

function stripLeadingApiList(sectionBody) {
  const lines = sectionBody.split("\n");
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim() === "") {
    cursor += 1;
  }
  if (cursor >= lines.length || !lines[cursor].startsWith("- ")) {
    return lines.slice(cursor).join("\n").trimEnd();
  }
  while (cursor < lines.length && lines[cursor].trim() !== "") {
    cursor += 1;
  }
  while (cursor < lines.length && lines[cursor].trim() === "") {
    cursor += 1;
  }
  return lines.slice(cursor).join("\n").trimEnd();
}

function packageSpecifier(packageName, subpath) {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
}

function packageRelativePath(entry) {
  return entry.path ?? `packages/${entry.dir}`;
}

function compareSubpaths(left, right) {
  if (left === ".") {
    return right === "." ? 0 : -1;
  }
  if (right === ".") {
    return 1;
  }
  return compareText(left, right);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
