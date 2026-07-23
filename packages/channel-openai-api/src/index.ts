import { MODULE_API_VERSION, defineChannelModule, type Channel, type ChannelModuleCreateContext, type ModuleHealth } from "@mono-agent/module-sdk";

import { type OpenAiApiConfig, openAiApiConfigSchema } from "./config.js";
import { createOpenAiApiServer, type OpenAiApiServer, type OpenAiApiStartInfo } from "./server.js";

export interface OpenAiApiModuleChannel extends Channel { readonly endpoint: string | undefined; readonly startInfo: OpenAiApiStartInfo | undefined; }

export const monoAgentModule = defineChannelModule({
  manifest: { packageName: "@mono-agent/channel-openai-api", packageVersion: "0.15.0", apiVersion: MODULE_API_VERSION, kind: "channel", responsibility: "Serves one selected agent through a bounded authenticated OpenAI-compatible API.", capabilities: [] },
  schema: openAiApiConfigSchema,
  create: createModule,
});

function createModule(context: ChannelModuleCreateContext<OpenAiApiConfig>): OpenAiApiModuleChannel {
  let server: OpenAiApiServer | undefined;
  return {
    capabilities: Object.freeze({ attachments: true, liveInput: false, askUser: false, approvals: false, proactive: false, runtimeControl: false, verbatim: false, cancellation: true }),
    get endpoint() { return server?.startInfo?.baseUrl; },
    get startInfo() { return server?.startInfo; },
    async start(startContext) { throwIfAborted(startContext.signal); server = createOpenAiApiServer({ config: context.config, dispatch: (request, reply) => context.host.dispatch(request, reply) }); const info = await server.start(); context.logger.info("OpenAI-compatible channel listening.", { instanceId: context.instanceId, endpoint: info.baseUrl, authRequired: true }); },
    async drain() { await server?.stop(); },
    async stop() { await server?.stop(); },
    async health(): Promise<ModuleHealth> { const snapshot = server?.health(); return { status: snapshot?.status === "healthy" ? "healthy" : snapshot?.status === "degraded" ? "degraded" : "unknown", checkedAt: new Date().toISOString(), ...(snapshot?.message === undefined ? {} : { summary: snapshot.message }), details: { activeRequests: snapshot?.activeRequests ?? 0, ...(server?.startInfo === undefined ? {} : { endpoint: server.startInfo.baseUrl }) } }; },
  };
}

function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("OpenAI API start aborted."); }

export * from "./config.js";
export * from "./server.js";
export * from "./translation.js";
