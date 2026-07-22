import process from "node:process";

import type { ParsedCliArgs } from "./cli-args.js";
import { installComposerCompanion } from "./docs-mcp-pairing.js";
import { agentAppPackageVersion } from "./package-version.js";
import { checkManagedProjectSkills, updateManagedProjectSkills } from "./project-skills.js";
import * as ui from "./ui.js";

export async function runInstallSkill(args: ParsedCliArgs): Promise<number> {
  if (args.project === true) {
    try {
      if (args.update === true) {
        const result = await updateManagedProjectSkills(process.cwd());
        for (const path of result.updated) {
          process.stdout.write(`${ui.badge("ok")}${ui.style.green("updated")}  ${path}\n`);
        }
        if (result.backupDir !== undefined) {
          process.stdout.write(`${ui.badge("ok")}backup    ${result.backupDir}\n`);
        }
        if (result.updated.length === 0) process.stdout.write(`${ui.badge("ok")}project skills are current\n`);
        process.stdout.write(`${ui.badge("ok")}docs MCP pairing skipped in project mode\n`);
        return 0;
      }
      const result = await checkManagedProjectSkills(process.cwd());
      // `--json` is gated to `--project --check` by the parser; keep stdout pure JSON.
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({
          ok: result.ok,
          skills: result.statuses.map((status) => ({ name: status.name, status: status.status, path: status.path })),
        })}\n`);
        return result.ok ? 0 : 1;
      }
      for (const status of result.statuses) {
        const badge = status.status === "ready" ? ui.badge("ok") : ui.badge("error");
        process.stdout.write(`${badge}${status.name}: ${status.status} (${status.path})\n`);
      }
      if (!result.ok && args.check !== true) {
        process.stderr.write(ui.errorLine("Project skills need attention. Run `mono-agent install-skill --project --update`; modified copies require manual reconciliation."));
      }
      process.stdout.write(`${ui.badge("ok")}docs MCP pairing skipped in project mode\n`);
      return result.ok ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "project-skills-check-failed", message } })}\n`);
        return 1;
      }
      process.stderr.write(ui.errorLine(message));
      return 1;
    }
  }
  let result;
  try {
    const docsMcpVersion = agentAppPackageVersion();
    result = await installComposerCompanion({
      target: args.target ?? "both",
      force: args.force,
      pairDocsMcp: args.noDocsMcp !== true,
      ...(docsMcpVersion === undefined ? {} : { docsMcpVersion }),
    });
  } catch (error) {
    process.stderr.write(ui.errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  for (const path of result.installed) {
    process.stdout.write(`${ui.badge("ok")}${ui.style.green("installed")}  ${path}\n`);
  }
  for (const pairing of result.pairings) {
    if (pairing.state === "skipped-missing") {
      process.stderr.write(`${ui.badge("waiting")}${pairing.target} CLI is unavailable; pair later with: ${pairing.command}\n`);
      continue;
    }
    process.stdout.write(`${ui.badge("ok")}${pairing.state.padEnd(15)} ${pairing.target}:mono-agent-docs\n`);
  }
  if (result.pairings.some((pairing) => pairing.state !== "skipped-missing")) {
    process.stdout.write(`${ui.badge("ok")}start a new harness session to load mono-agent-docs\n`);
  }
  return 0;
}
