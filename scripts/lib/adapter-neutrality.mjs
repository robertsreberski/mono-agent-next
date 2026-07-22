import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const ADAPTER_NEUTRAL_SOURCE_DIRS = [
  "packages/module-sdk/src",
  "packages/core/src",
];

const IGNORED_SOURCE_DIRS = new Set(["__fixtures__", "__tests__", "fixtures"]);
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/u;
const TEST_FILE_PATTERN = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;

export function findAdapterNeutralityErrors({
  root,
  channelIds,
  sourceDirs = ADAPTER_NEUTRAL_SOURCE_DIRS,
}) {
  const errors = [];
  for (const sourceDir of sourceDirs) {
    const absoluteSourceDir = join(root, sourceDir);
    if (!existsSync(absoluteSourceDir)) {
      errors.push(`${sourceDir} is missing; adapter-neutrality could not be checked.`);
      continue;
    }
    for (const file of walkProductionSourceFiles(absoluteSourceDir)) {
      const text = readFileSync(file, "utf8");
      for (const channelId of hardcodedChannelPrefixes(text, channelIds)) {
        errors.push(
          `${relative(root, file)} must stay adapter-neutral; `
          + `hardcodes shipped channel prefix "${channelId}:".`,
        );
      }
    }
  }
  return errors;
}

export function hardcodedChannelPrefixes(text, channelIds) {
  return channelIds.filter((channelId) => channelPrefixPattern(channelId).test(text));
}

function channelPrefixPattern(channelId) {
  const escaped = channelId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // A left boundary keeps ids such as `live` from matching identifiers like
  // `sessionKeepAlive:` while still catching strings, templates, and regexes.
  return new RegExp(`(^|[^A-Za-z0-9_$-])${escaped}:`, "u");
}

function walkProductionSourceFiles(dir) {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_SOURCE_DIRS.has(entry.name)) {
        files.push(...walkProductionSourceFiles(join(dir, entry.name)));
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_FILE_PATTERN.test(entry.name) || TEST_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    files.push(join(dir, entry.name));
  }
  return files;
}
