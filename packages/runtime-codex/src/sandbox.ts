// SPDX-License-Identifier: MIT
import type { SandboxExecutor } from "@mono-agent/module-sdk/internal";

import type { ProcessLike, SpawnProcess } from "./json-rpc.js";

export function codexSandboxSpawn(
  executor: SandboxExecutor,
): SpawnProcess {
  return (command, args, options): ProcessLike => {
    const environment: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(options.env)) {
      if (value !== undefined) environment[name] = value;
    }
    return executor.spawn({
      command,
      arguments: Object.freeze([...args]),
      workingDirectory: options.cwd,
      environment: Object.freeze(environment),
    });
  };
}
