#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_LINE_LENGTH_MAXIMUM = 140;

/** Shipped package source, which is what the production line budget measures. */
const PRODUCTION_SOURCE = /^(?:packages|extras)\/[^/]+\/(?:src|webapp\/src)\/.+\.(?:ts|tsx|mts|cts)$/u;
const TEST_SOURCE = /(?:\/__tests__\/|\.test\.tsx?$)/u;

/**
 * Files that already exceed the limit, exempted so the gate can widen from two
 * files to every production file without a 231-line reformatting commit.
 *
 * This list may only shrink: `collectSourceLineLengthFindings` reports an
 * exemption whose file is now clean, so a fixed file must be removed from here,
 * and a file cannot be added to duck a new violation without that being a
 * visible, reviewable edit.
 */
export const SOURCE_LINE_LENGTH_EXEMPTIONS = Object.freeze([
  "extras/docs-mcp/src/reader.ts",
  "extras/docs-mcp/src/search.ts",
  "extras/docs-mcp/src/server.ts",
  "packages/channel-openai-api/src/config.ts",
  "packages/channel-openai-api/src/index.ts",
  "packages/channel-openai-api/src/server.ts",
  "packages/channel-openai-api/src/tool-details.ts",
  "packages/channel-openai-api/src/translation.ts",
  "packages/channel-operator/src/index.ts",
  "packages/channel-operator/src/server.ts",
  "packages/channel-slack/src/config.ts",
  "packages/channel-slack/src/delivery.ts",
  "packages/channel-slack/src/inbox.ts",
  "packages/channel-slack/src/send-tools.ts",
  "packages/channel-slack/src/socket.ts",
  "packages/channel-telegram/src/bot.ts",
  "packages/channel-telegram/src/config.ts",
  "packages/channel-telegram/src/delivery.ts",
  "packages/channel-telegram/src/index.ts",
  "packages/channel-telegram/src/send-tools.ts",
  "packages/channel-webhook/src/config.ts",
  "packages/channel-webhook/src/delivery.ts",
  "packages/channel-webhook/src/server.ts",
  "packages/core/src/errors.ts",
  "packages/core/src/host-instructions.ts",
  "packages/core/src/host-submit-input.ts",
  "packages/core/src/host-types.ts",
  "packages/core/src/host.ts",
  "packages/core/src/mcp.ts",
  "packages/core/src/module-loader.ts",
  "packages/core/src/schema.ts",
  "packages/create-mono-agent/src/cli.ts",
  "packages/create-mono-agent/src/templates.ts",
  "packages/memory-local/src/bujo-db.ts",
  "packages/memory-local/src/cli.ts",
  "packages/memory-local/src/store.ts",
  "packages/module-sdk/src/modules.ts",
  "packages/module-sdk/src/testing.ts",
  "packages/operator/src/client.ts",
  "packages/operator/src/directory.ts",
  "packages/operator/src/protocol.ts",
  "packages/operator/src/testing.ts",
  "packages/runtime-claude/src/cli.ts",
  "packages/runtime-claude/src/config.ts",
  "packages/runtime-claude/src/runtime.ts",
  "packages/runtime-claude/src/sdk.ts",
  "packages/runtime-codex/src/json-rpc.ts",
  "packages/runtime-codex/src/runtime.ts",
  "packages/runtime-opencode/src/config.ts",
  "packages/runtime-pi/src/runtime-tools.ts",
  "packages/sandbox-srt/src/config.ts",
  "packages/sandbox-srt/src/sandbox.ts",
  "packages/service-macos/src/index.ts",
  "packages/service-macos/src/input.ts",
  "packages/service-macos/src/plist.ts",
  "packages/service-macos/src/transactions.ts",
  "packages/state-local/src/run-history-tool.ts",
  "packages/tui/src/ui/app.ts",
  "packages/web/src/operator-gateway.ts",
  "packages/web/src/server.ts",
  "packages/web/src/store.ts",
  "packages/web/webapp/src/components/Icon.tsx",
]);

export function listProductionSourcePaths(cwd) {
  return execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" })
    .split("\n")
    .filter((path) => PRODUCTION_SOURCE.test(path) && !TEST_SOURCE.test(path))
    .sort();
}

export function collectSourceLineLengthFindings(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const readFile = options.readFile ?? readFileSync;
  const paths = options.paths ?? listProductionSourcePaths(cwd);
  const exempt = new Set(options.exemptions ?? SOURCE_LINE_LENGTH_EXEMPTIONS);
  const findings = [];
  const stillOverlong = new Set();

  for (const path of paths) {
    const source = readFile(resolve(cwd, path), "utf8");
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      const length = [...line].length;
      if (length <= SOURCE_LINE_LENGTH_MAXIMUM) continue;
      if (exempt.has(path)) {
        stillOverlong.add(path);
        continue;
      }
      findings.push(Object.freeze({ path, line: index + 1, length }));
    }
  }

  for (const path of exempt) {
    if (stillOverlong.has(path)) continue;
    findings.push(Object.freeze({
      path,
      line: 0,
      length: 0,
      staleExemption: true,
    }));
  }

  return Object.freeze(findings);
}

export function renderSourceLineLengthReport(findings) {
  if (findings.length === 0) {
    return `Source line-length check passed (maximum ${String(SOURCE_LINE_LENGTH_MAXIMUM)} characters, `
      + `${String(SOURCE_LINE_LENGTH_EXEMPTIONS.length)} exempted file(s))\n`;
  }
  return [
    `Source line-length check failed (${String(findings.length)} finding(s))`,
    ...findings.map((finding) => finding.staleExemption === true
      ? `${finding.path} no longer exceeds the limit; remove it from SOURCE_LINE_LENGTH_EXEMPTIONS`
      : `${finding.path}:${String(finding.line)} has ${String(finding.length)} characters `
        + `(maximum ${String(SOURCE_LINE_LENGTH_MAXIMUM)})`),
    "",
  ].join("\n");
}

export function runCheckSourceLineLength(options = {}) {
  const findings = collectSourceLineLengthFindings(options);
  const stdout = options.stdout ?? process.stdout;
  stdout.write(renderSourceLineLengthReport(findings));
  return Object.freeze({
    exitCode: findings.length === 0 ? 0 : 1,
    findings,
  });
}

const isCli = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  process.exitCode = runCheckSourceLineLength().exitCode;
}
