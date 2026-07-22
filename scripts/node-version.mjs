#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const MINIMUM_NODE_VERSION = "22.19.0";
export const SUPPORTED_NODE_ENGINE = `>=${MINIMUM_NODE_VERSION}`;

export function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (match === null) {
    throw new Error(`Could not parse Node.js version ${JSON.stringify(value)}.`);
  }
  return match.slice(1, 4).map(Number);
}

export function isSupportedNodeVersion(value) {
  const actual = parseNodeVersion(value);
  const minimum = parseNodeVersion(MINIMUM_NODE_VERSION);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export function assertSupportedNodeVersion(value = process.versions.node) {
  if (!isSupportedNodeVersion(value)) {
    throw new Error(
      `mono-agent requires Node.js ${SUPPORTED_NODE_ENGINE}; current Node.js is ${value}. `
      + `Install Node.js ${MINIMUM_NODE_VERSION} or newer and retry.`,
    );
  }
}

function main() {
  assertSupportedNodeVersion();
  console.log(`Node.js ${process.versions.node} satisfies mono-agent ${SUPPORTED_NODE_ENGINE}.`);
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
