#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { packageCatalog } from "./package-catalog.mjs";
import {
  collectPackageDocModel,
  PACKAGE_DIRECTORY_END,
  PACKAGE_DIRECTORY_START,
  PACKAGE_GRAPH_END,
  PACKAGE_GRAPH_START,
  renderPackageDependencyGraph,
  renderPackageDirectory,
  renderPackageMetadata,
  updateMarkedBlock,
  updatePackageReadmeMetadata,
} from "./lib/package-docs.mjs";

const root = process.cwd();
const model = collectPackageDocModel({ root, catalog: packageCatalog });
let changedFiles = 0;

for (const entry of model) {
  const readmePath = join(root, entry.packagePath, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const next = updatePackageReadmeMetadata(readme, renderPackageMetadata(entry));
  changedFiles += writeWhenChanged(readmePath, readme, next);
}

const packagesPath = join(root, "PACKAGES.md");
const packages = readFileSync(packagesPath, "utf8");
const nextPackages = updateMarkedBlock(
  updateMarkedBlock(
    packages,
    PACKAGE_GRAPH_START,
    PACKAGE_GRAPH_END,
    renderPackageDependencyGraph(model),
  ),
  PACKAGE_DIRECTORY_START,
  PACKAGE_DIRECTORY_END,
  renderPackageDirectory(model),
);
changedFiles += writeWhenChanged(packagesPath, packages, nextPackages);

const websiteDirectoryPath = join(root, "docs/reference/packages.md");
const websiteDirectory = readFileSync(websiteDirectoryPath, "utf8");
const nextWebsiteDirectory = updateMarkedBlock(
  websiteDirectory,
  PACKAGE_DIRECTORY_START,
  PACKAGE_DIRECTORY_END,
  renderPackageDirectory(model, { website: true }),
);
changedFiles += writeWhenChanged(websiteDirectoryPath, websiteDirectory, nextWebsiteDirectory);

console.log(`Package documentation is current for ${model.length} packages (${changedFiles} files updated).`);

function writeWhenChanged(path, current, next) {
  if (current === next) return 0;
  writeFileSync(path, next);
  return 1;
}
