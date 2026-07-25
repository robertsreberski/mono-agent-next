#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { findDocumentationErrors } from "./lib/docs-quality.mjs";

const errors = findDocumentationErrors({ root: process.cwd() });
if (errors.length > 0) {
  console.error("Documentation quality check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Documentation quality check passed.");
}
