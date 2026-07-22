export type {
  AgentMessageStreamLike,
  AgentRequestLike,
  AgentResponderLike,
  AgentResponseLike,
} from "./agent/responder.js";

export type {
  CreateInMemoryTuiHistoryOptions,
  TuiHistoryMessage,
  TuiHistoryRole,
  TuiHistoryStatus,
  TuiHistoryStore,
} from "./agent/history.js";
export { createInMemoryTuiHistory } from "./agent/history.js";

export type {
  BuildTuiConfigSummaryInput,
  TuiConfigFieldSource,
  TuiConfigFieldSummary,
  TuiConfigSummarySection,
} from "./config/pane.js";
export { buildTuiConfigSummary } from "./config/pane.js";

export { RemoteAgentResponder, RemoteAgentResponderError } from "./remote/client.js";
export type { RemoteAgentResponderOptions } from "./remote/client.js";

export {
  defaultTraceRegistryDir,
  discoverInstances,
  resolveInstanceApiKey,
  toInstance,
} from "./data/instances.js";
export type {
  DiscoverInstancesOptions,
  DiscoveredInstance,
  TraceSourceListItem,
} from "./data/instances.js";

export { listReplayRuns, readReplayRun } from "./data/replay.js";
export type {
  ListReplayRunsOptions,
  ListReplayRunsResult,
  ReplayRunConfig,
  ReplayRunDetail,
  ReplayRunListItem,
  ReplayTimelineItem,
  TimelineTurn,
} from "./data/replay.js";

export { TurnPresenter } from "./ui/turn-presenter.js";
export type { TurnPresenterOptions } from "./ui/turn-presenter.js";

export { MonoAgentTuiApp } from "./ui/app.js";
export type {
  ConfigurationProposalCard,
  ConfigurationProposalResult,
  MonoAgentTuiAppOptions,
  TuiAppLogger,
  TuiConfigurationController,
  TuiViewId,
} from "./ui/app.js";

export type {
  StartMonoAgentTuiHandle,
  StartMonoAgentTuiOptions,
} from "./runtime/start.js";
export { startMonoAgentTui } from "./runtime/start.js";
