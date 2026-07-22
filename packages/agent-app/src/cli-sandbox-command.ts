import process from "node:process";

import type { ParsedCliArgs } from "./cli-args.js";
import { attachScopedKeypress, isAbortLike } from "./cli-cancellation.js";
import {
  checkSandboxRuntime,
  sandboxRuntimeStatus,
  setupManagedSrt,
} from "./sandbox-manager.js";
import type {
  ManagedSrtSetupResult,
  SandboxCheckResult,
  SandboxRuntimeStatus,
} from "./sandbox-manager.js";
import * as ui from "./ui.js";

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SandboxCommandDependencies {
  readonly status: typeof sandboxRuntimeStatus;
  readonly setup: typeof setupManagedSrt;
  readonly check: typeof checkSandboxRuntime;
}

const DEFAULT_SANDBOX_COMMAND_DEPENDENCIES: SandboxCommandDependencies = {
  status: sandboxRuntimeStatus,
  setup: setupManagedSrt,
  check: checkSandboxRuntime,
};

/** App-owned sandbox lifecycle surface; safe to inject in focused CLI tests. */
export async function runSandboxCommand(
  args: Pick<ParsedCliArgs, "positionals" | "json">,
  dependencies: SandboxCommandDependencies = DEFAULT_SANDBOX_COMMAND_DEPENDENCIES,
): Promise<number> {
  const json = args.json === true;
  const [subcommand, ...extra] = args.positionals;
  if ((subcommand !== "status" && subcommand !== "setup" && subcommand !== "check") || extra.length > 0) {
    process.stderr.write(ui.errorLine("[sandbox_usage] Usage: mono-agent sandbox status | setup | check."));
    return 2;
  }

  if (subcommand === "status") {
    try {
      const status = await dependencies.status();
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, sandbox: status })}\n`);
      } else {
        printSandboxRuntimeStatus(status);
      }
      return 0;
    } catch (error) {
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "sandbox_status_failed", message: reasonOf(error) } })}\n`);
      } else {
        process.stderr.write(ui.errorLine(`[sandbox_status_failed] ${reasonOf(error)}`));
      }
      return 1;
    }
  }

  return await withScopedSandboxCancellation(async (signal) => {
    try {
      if (subcommand === "setup") {
        process.stdout.write(ui.heading("Sandbox setup"));
        process.stdout.write(ui.style.dim("Installing the pinned SRT copy in the user cache; no PATH, global npm, or system-package changes will be made.\n"));
        const result = await dependencies.setup({ signal, verify: true });
        printSandboxSetupResult(result);
        return 0;
      }
      process.stdout.write(ui.heading("Sandbox check"));
      const result = await dependencies.check({ signal });
      printSandboxCheckResult(result);
      return 0;
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("[sandbox_interrupted] Sandbox operation was interrupted; no partial success was claimed."));
        process.stderr.write(ui.hint(`Retry safely with \`mono-agent sandbox ${subcommand}\`.\n`));
        return 130;
      }
      const code = subcommand === "setup" ? "sandbox_setup_failed" : "sandbox_check_failed";
      process.stderr.write(ui.errorLine(`[${code}] ${reasonOf(error)}`));
      process.stderr.write(ui.hint(`Retry with \`mono-agent sandbox ${subcommand}\` after resolving the error.\n`));
      return 1;
    }
  });
}

function printSandboxRuntimeStatus(status: SandboxRuntimeStatus): void {
  process.stdout.write(ui.heading("Sandbox status"));
  process.stdout.write(`  State: ${status.state}\n`);
  process.stdout.write(`  Source: ${status.source}\n`);
  process.stdout.write(`  Cache: ${status.installRoot}\n`);
  process.stdout.write(`  Detail: ${status.message}\n`);
}

function printSandboxCheckResult(result: SandboxCheckResult): void {
  printSandboxRuntimeStatus(result.status);
  process.stdout.write(ui.heading("Functional enforcement"));
  for (const check of result.checks) {
    process.stdout.write(`${check.ok ? ui.badge("ok") : ui.badge("error")}${check.id}: ${check.detail}\n`);
  }
}

function printSandboxSetupResult(result: ManagedSrtSetupResult): void {
  printSandboxRuntimeStatus(result.status);
  const action = result.repaired ? "repaired" : result.installed ? "installed" : "already installed";
  process.stdout.write(`${ui.badge("ok")}Managed SRT ${action}; integrity verification passed.\n`);
  if (result.check !== undefined) printSandboxCheckResult(result.check);
}

async function withScopedSandboxCancellation(
  task: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let interrupts = 0;
  const interrupt = (): void => {
    interrupts += 1;
    controller.abort();
  };
  const onKeypress = (_value: string, key: { readonly name?: string } | undefined): void => {
    if (key?.name === "escape") interrupt();
  };
  process.on("SIGINT", interrupt);
  const restoreKeypress = attachScopedKeypress(onKeypress);
  try {
    const result = await task(controller.signal);
    return interrupts > 1 ? 130 : result;
  } finally {
    process.off("SIGINT", interrupt);
    restoreKeypress();
  }
}
