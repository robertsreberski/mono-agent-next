#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { packageCatalog } from "./package-catalog.mjs";
import {
  collectPackagePublicApiInventories,
  JS_SUBPATH_INVENTORY_START,
  renderJsSubpathInventory,
  renderPublicApiInventory,
  updateMigrationJsSubpathInventory,
  updateReadmePublicApiInventory,
} from "./lib/public-api-docs.mjs";

const root = process.cwd();
const { inventories, errors } = collectPackagePublicApiInventories({ root, catalog: packageCatalog });
if (errors.length > 0) {
  console.error("Public API documentation generation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

let changedFiles = 0;
for (const inventory of inventories) {
  const readmePath = join(root, inventory.packagePath, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const nextReadme = updateReadmePublicApiInventory(readme, renderPublicApiInventory(inventory));
  if (nextReadme !== readme) {
    writeFileSync(readmePath, nextReadme);
    changedFiles += 1;
  }

  const migrationPath = join(root, inventory.packagePath, "MIGRATION.md");
  let migration;
  try {
    migration = readFileSync(migrationPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  if (!migration.includes(JS_SUBPATH_INVENTORY_START)) {
    continue;
  }
  const nextMigration = updateMigrationJsSubpathInventory(migration, renderJsSubpathInventory(inventory));
  if (nextMigration !== migration) {
    writeFileSync(migrationPath, nextMigration);
    changedFiles += 1;
  }
}

console.log(`Public API documentation is current for ${inventories.length} packages (${changedFiles} files updated).`);
