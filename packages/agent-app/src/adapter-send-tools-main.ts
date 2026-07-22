#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createAdapterSendProxy,
  safeAdapterSendProxyErrorMessage,
} from "./adapter-send-proxy.js";
import {
  adapterSendToolsChildConfigFromEnv,
  createAdapterSendToolsClients,
  createAdapterSendToolsServer,
  resolveAdapterSendToolsSettings,
} from "./adapter-send-tools.js";

async function main(): Promise<void> {
  const childConfig = adapterSendToolsChildConfigFromEnv(process.env, process.cwd());
  const settings = await resolveAdapterSendToolsSettings(childConfig.input, {
    allowedTools: childConfig.allowedTools,
  });
  if (settings === undefined) {
    throw new Error("no adapter send tools configured.");
  }
  const proxy = createAdapterSendProxy(process.env, {
    directLoopbackUrls: [
      settings.telegram?.apiRoot,
      settings.askUser?.bridgeUrl,
      childConfig.deliveryHistory?.bridgeUrl,
    ].filter((value): value is string => value !== undefined),
  });
  const removeProxyLifecycle = proxy === undefined ? () => {} : installProxyLifecycle(proxy);
  try {
    const httpOptions = {
      ...(proxy === undefined ? {} : { fetchImpl: proxy.fetchImpl }),
      ...(childConfig.deliveryHistory === undefined
        ? {}
        : { deliveryHistory: childConfig.deliveryHistory }),
    };
    const clients = await createAdapterSendToolsClients(settings, httpOptions);
    const server = await createAdapterSendToolsServer(settings, clients, childConfig.indexing, httpOptions);
    await server.connect(new StdioServerTransport());
  } catch (error) {
    removeProxyLifecycle();
    await proxy?.destroy().catch((closeError: unknown) => {
      logProxyShutdownError(closeError);
    });
    throw error;
  }
}

function installProxyLifecycle(proxy: NonNullable<ReturnType<typeof createAdapterSendProxy>>): () => void {
  let gracefulShutdown: Promise<void> | undefined;
  let forcedShutdown: Promise<void> | undefined;
  const shutdown = (force: boolean, exitAfter: boolean): void => {
    const operation = force
      ? (forcedShutdown ??= proxy.destroy())
      : (gracefulShutdown ??= proxy.close());
    void operation
      .catch((error: unknown) => {
        logProxyShutdownError(error);
      })
      .finally(() => {
        if (exitAfter) process.exit(0);
      });
  };
  const onStdinEnd = (): void => {
    shutdown(false, false);
  };
  const onSignal = (): void => {
    // Installing signal handlers replaces Node's default termination behavior,
    // so destroy active requests and exit explicitly once the dispatcher drains.
    shutdown(true, true);
  };
  process.stdin.once("end", onStdinEnd);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.stdin.off("end", onStdinEnd);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

function logProxyShutdownError(error: unknown): void {
  void error;
  // Dispatcher errors can include the proxy URL. Keep credentials out of MCP
  // stderr even when the underlying client reports an unsafe diagnostic.
  process.stderr.write("mono-agent-adapter-send-tools: proxy shutdown failed.\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`mono-agent-adapter-send-tools: fatal: ${safeAdapterSendProxyErrorMessage(error)}\n`);
  process.exitCode = 1;
});
