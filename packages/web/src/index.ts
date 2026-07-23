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
  AnswerWebAskInput,
  CreateWebThreadInput,
  OfferWebLiveInput,
  StartWebTurnInput,
  WebAgent,
  WebAskAnswerResult,
  WebBootstrap,
  WebConfigView,
  WebHealthView,
  WebLiveInputResult,
  WebMessage,
  WebReplayView,
  WebThread,
  WebThreadDetail,
  WebTurnStatus,
} from "./contracts.js";

export { startWebServer } from "./server.js";
export type { StartWebServerOptions, WebServerHandle } from "./server.js";
export type {
  WebOperatorGateway,
  WebOperatorTurnInput,
  WebProactiveConversation,
} from "./service.js";
export { WebProductError } from "./errors.js";
