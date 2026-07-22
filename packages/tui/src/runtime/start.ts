import { ProcessTerminal } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";

import { MonoAgentTuiApp } from "../ui/app.js";
import type { MonoAgentTuiAppOptions } from "../ui/app.js";

export interface StartMonoAgentTuiOptions extends Omit<MonoAgentTuiAppOptions, "terminal"> {
  /** Test seam: inject a Terminal implementation; defaults to the real TTY. */
  readonly terminal?: Terminal;
}

export interface StartMonoAgentTuiHandle {
  /** Resolves once the app exits (user quit or programmatic stop). */
  waitUntilExit(): Promise<void>;
  /** Stop the app and restore the TTY. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start the pi-tui operator console. Exactly one connection mode applies:
 * `responder` (in-process/embedded), `connection` (direct remote endpoint), or
 * `discovery` (open on the agent picker). Replay/config views activate when
 * `instance`/`config` provide data roots.
 */
export function startMonoAgentTui(options: StartMonoAgentTuiOptions): StartMonoAgentTuiHandle {
  const modes = [options.responder, options.connection, options.discovery].filter(
    (mode) => mode !== undefined,
  ).length;
  if (modes !== 1) {
    throw new Error(
      "startMonoAgentTui requires exactly one of `responder`, `connection`, or `discovery`.",
    );
  }
  if (options.terminal === undefined && process.stdin.isTTY !== true) {
    throw new Error("startMonoAgentTui requires a TTY stdin. Pass a terminal manually for non-TTY use.");
  }

  const { terminal, ...appOptions } = options;
  const app = new MonoAgentTuiApp({
    ...appOptions,
    terminal: terminal ?? new ProcessTerminal(),
  });
  app.start();

  return {
    async waitUntilExit(): Promise<void> {
      await app.waitUntilExit();
    },
    async stop(): Promise<void> {
      app.stop();
    },
  };
}
