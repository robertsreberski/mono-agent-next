import { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import {
  createOperatorClientForEntry,
  discoverOperators,
  OperatorClient,
  OperatorDirectory,
  type DiscoveredOperator,
} from "@mono-agent/operator";

import { MonoAgentTuiApp } from "../ui/app.js";

export interface StartMonoAgentTuiOptions {
  /** Direct authenticated loopback endpoint. Omit to use shared registry discovery. */
  readonly endpoint?: string;
  readonly token?: string;
  readonly registryDirectories?: readonly string[];
  readonly operatorId?: string;
  readonly conversationId?: string;
  readonly title?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly terminal?: Terminal;
  readonly fetch?: typeof globalThis.fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
}

export interface StartMonoAgentTuiHandle {
  waitUntilExit(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start the standalone renderer. A manually injected Terminal is the supported
 * non-TTY test seam; production calls require an interactive stdin.
 */
export async function startMonoAgentTui(
  options: StartMonoAgentTuiOptions = {},
): Promise<StartMonoAgentTuiHandle> {
  if (options.endpoint !== undefined && options.registryDirectories !== undefined) {
    throw new Error("startMonoAgentTui accepts either endpoint or registryDirectories, not both");
  }
  if (options.token !== undefined && options.endpoint === undefined) {
    throw new Error("startMonoAgentTui token requires a direct endpoint");
  }
  if (options.endpoint !== undefined && options.operatorId !== undefined) {
    throw new Error("startMonoAgentTui operatorId applies only to discovery");
  }
  if (options.terminal === undefined && process.stdin.isTTY !== true) {
    throw new Error("startMonoAgentTui requires a TTY; inject terminal for non-TTY tests");
  }

  const clientOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  };
  let discoveredOperator: DiscoveredOperator | undefined;
  let client: OperatorClient;
  if (options.endpoint === undefined) {
    discoveredOperator = new OperatorDirectory(await discoverOperators(
        options.registryDirectories === undefined
          ? {}
          : { registryDirectories: options.registryDirectories },
      )).select(options.operatorId);
    client = createOperatorClientForEntry(discoveredOperator, {
      ...clientOptions,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } else {
    client = new OperatorClient({
        endpoint: options.endpoint,
        ...(options.token === undefined ? {} : { token: options.token }),
        ...clientOptions,
      });
  }

  const app = new MonoAgentTuiApp({
    client,
    terminal: options.terminal ?? new ProcessTerminal(),
    conversationId: options.conversationId ?? `tui-${crypto.randomUUID()}`,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(discoveredOperator === undefined ? {} : { discoveredOperator }),
  });
  try {
    await app.start();
  } catch (error) {
    app.stop();
    throw error;
  }

  return {
    waitUntilExit: () => app.waitUntilExit(),
    async stop(): Promise<void> { app.stop(); },
  };
}
