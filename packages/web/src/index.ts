/** Standalone authenticated browser product over `@mono-agent/operator`. */
export { loadWebConfig, parseWebConfig, webConfigJsonSchema } from "./config.js";
export type {
  LoadWebConfigOptions,
  ParseWebConfigOptions,
  WebConfig,
  WebListenConfig,
} from "./config.js";

export { WEB_API_VERSION } from "./contracts.js";
export type {
  CreateWebThreadInput,
  StartWebTurnInput,
  WebAgent,
  WebBootstrap,
  WebMessage,
  WebThread,
  WebThreadDetail,
  WebTurnStatus,
} from "./contracts.js";

export { startWebServer } from "./server.js";
export type { StartWebServerOptions, WebServerHandle } from "./server.js";
export type { WebOperatorGateway, WebOperatorTurnInput } from "./service.js";
export { WebProductError } from "./errors.js";
