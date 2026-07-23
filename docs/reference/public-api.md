---
title: "Public API inventory"
description: "Generated package-by-package inventory of every public code entrypoint and named export in mono-agent v1."
sidebar:
  order: 3
---

This page is generated from each publishable package's `exports` map and
source entrypoint. Package READMEs contain the same generated symbol
inventories next to curated start-here guidance.

Regenerate both surfaces with:

```bash
pnpm run generate:public-api-docs
pnpm run generate:source-beta-docs
```

| Package | Public entrypoints | Named exports | Package API |
| --- | ---: | ---: | --- |
| `@mono-agent/module-sdk` | 5 | 331 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/module-sdk/README.md) |
| `@mono-agent/core` | 1 | 59 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/core/README.md) |
| `@mono-agent/cli` | 1 | 4 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/cli/README.md) |
| `@mono-agent/runtime-pi` | 1 | 6 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/runtime-pi/README.md) |
| `@mono-agent/runtime-claude` | 1 | 6 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/runtime-claude/README.md) |
| `@mono-agent/runtime-codex` | 1 | 4 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/runtime-codex/README.md) |
| `@mono-agent/runtime-opencode` | 1 | 4 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/runtime-opencode/README.md) |
| `@mono-agent/channel-telegram` | 1 | 31 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/channel-telegram/README.md) |
| `@mono-agent/channel-slack` | 1 | 36 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/channel-slack/README.md) |
| `@mono-agent/channel-webhook` | 1 | 42 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/channel-webhook/README.md) |
| `@mono-agent/channel-openai-api` | 1 | 25 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/channel-openai-api/README.md) |
| `@mono-agent/channel-operator` | 1 | 20 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/channel-operator/README.md) |
| `@mono-agent/trigger-cron` | 1 | 29 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/trigger-cron/README.md) |
| `@mono-agent/memory-local` | 1 | 46 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/memory-local/README.md) |
| `@mono-agent/state-local` | 1 | 26 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/state-local/README.md) |
| `@mono-agent/exporter-otlp` | 1 | 13 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/exporter-otlp/README.md) |
| `@mono-agent/sandbox-srt` | 1 | 14 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/sandbox-srt/README.md) |
| `@mono-agent/operator` | 2 | 98 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/operator/README.md) |
| `@mono-agent/tui` | 1 | 8 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/tui/README.md) |
| `@mono-agent/web` | 1 | 31 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/web/README.md) |
| `create-mono-agent` | 1 | 24 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/create-mono-agent/README.md) |
| `@mono-agent/docs-mcp` | 1 | 14 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/extras/docs-mcp/README.md) |
| `@mono-agent/service-macos` | 1 | 59 | [README](https://github.com/robertsreberski/mono-agent-next/blob/main/packages/service-macos/README.md) |

## Entrypoints and symbols

## `@mono-agent/module-sdk`

### `@mono-agent/module-sdk`

```text
AGENT_INTERACTION_LIMITS
ASK_USER_MAX_ANSWER_BYTES
ASK_USER_MAX_CHOICES_PER_QUESTION
ASK_USER_MAX_QUESTIONS
AgentInteractionHandler
ApprovalDecision
ApprovalRequest
ArtifactRef
AskUserAnswer
AskUserChoice
AskUserQuestion
AskUserRequest
AtomicReplaceOwnerPrivateFileOptions
AttachmentKind
Awaitable
BoundedHttpResponse
Channel
ChannelActor
ChannelApprovalAnswerResult
ChannelAskAnswerResult
ChannelAttachment
ChannelCancelRequest
ChannelCancelResult
ChannelCapabilities
ChannelConversationListRequest
ChannelConversationListResult
ChannelConversationSummary
ChannelDeliveryResult
ChannelHost
ChannelInboundRequest
ChannelLiveInput
ChannelLiveInputResult
ChannelModuleCreateContext
ChannelModuleDefinition
ChannelOpenConversationRequest
ChannelOpenConversationResult
ChannelOutboundMessage
ChannelReplayEntry
ChannelReplayRequest
ChannelReplayResult
ChannelReplyActivityEvent
ChannelReplyApprovalEvent
ChannelReplyAskUserEvent
ChannelReplyAttachmentEvent
ChannelReplyCompactionEvent
ChannelReplyEvent
ChannelReplySessionEvictedEvent
ChannelReplySink
ChannelReplyTextDeltaEvent
ChannelReplyTextReplaceEvent
ChannelReplyToolCallEvent
ChannelReplyToolResultEvent
ChannelReplyUsageEvent
ChannelSendTool
ChannelSendToolContext
ChannelTurnResult
CheckedFetchOptions
ConfigIssue
ConfigPath
ConfigPathSegment
ConfigProvenance
ConfigProvenanceMap
ConfigProvenanceSource
CrossSlotReference
DEFAULT_APPROVAL_TIMEOUT_MS
DEFAULT_HTTP_MAX_REDIRECTS
DEFAULT_HTTP_MAX_RESPONSE_BYTES
DEFAULT_HTTP_TIMEOUT_MS
DEFAULT_OWNER_PRIVATE_READ_MAX_BYTES
EnvEligibleSchemaOptions
HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE
HttpSafetyError
HttpSafetyErrorCode
InteractionContext
JsonObject
JsonPrimitive
JsonSchema
JsonValue
MODULE_API_VERSION
MODULE_SCHEMA_ENV_ELIGIBLE
MODULE_SCHEMA_SECRET
MODULE_SCHEMA_SLOT_REFERENCE
Memory
MemoryCapabilities
MemoryCaptureRequest
MemoryForgetRequest
MemoryHost
MemoryModuleCreateContext
MemoryModuleDefinition
MemoryRecallRequest
MemoryRecallResult
MemoryRecord
MemoryRuntimeCaptureGrant
MemoryRuntimeCaptureRequest
MemoryRuntimeCaptureResult
ModuleApiVersion
ModuleCapability
ModuleCommand
ModuleCommandContext
ModuleCommandKind
ModuleConfigError
ModuleConfigErrorOptions
ModuleConfigSchema
ModuleCreateContext
ModuleDiagnostic
ModuleDiagnosticSeverity
ModuleDiagnosticsContext
ModuleDrainContext
ModuleHealth
ModuleHealthContext
ModuleHealthStatus
ModuleHost
ModuleInstance
ModuleKind
ModuleLogFields
ModuleLogger
ModuleManifest
ModuleSchema
ModuleSlot
ModuleStartContext
ModuleStopContext
ModuleStopReason
MonoAgentModule
NormalizedAttachment
OPEN_MODULE_KINDS
OWNER_PRIVATE_DIRECTORY_MODE
OWNER_PRIVATE_FILE_MODE
OpenModuleDefinition
OwnerPrivateOperationOptions
OwnerPrivatePathError
OwnerPrivatePathErrorCode
OwnerPrivatePathIdentity
ParseModuleConfigOptions
RUNTIME_SESSION_UNAVAILABLE_CODE
RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES
ReadOwnerPrivateFileOptions
RouteIdentity
Runtime
RuntimeCapabilities
RuntimeCompaction
RuntimeCompactionEvent
RuntimeCompletedTurnResult
RuntimeDiagnosticEvent
RuntimeHost
RuntimeIncompleteTurnResult
RuntimeLiveInput
RuntimeLiveInputDisposition
RuntimeLiveInputHandler
RuntimeModelPreflightRequest
RuntimeModelPreflightResult
RuntimeModelValidation
RuntimeModelValidationRequest
RuntimeModuleCreateContext
RuntimeModuleDefinition
RuntimeNativeToolApprovalEnforcement
RuntimeNativeToolDescriptor
RuntimeNativeToolEffect
RuntimeNativeToolSandboxEnforcement
RuntimeRetryability
RuntimeSession
RuntimeSessionEvent
RuntimeSideEffectStatus
RuntimeTextDeltaEvent
RuntimeThinkingDeltaEvent
RuntimeToolCall
RuntimeToolCallEvent
RuntimeToolDefinition
RuntimeToolResult
RuntimeToolResultArtifactPart
RuntimeToolResultEvent
RuntimeToolResultFilePart
RuntimeToolResultJsonPart
RuntimeToolResultPart
RuntimeToolResultTextPart
RuntimeTurnContext
RuntimeTurnError
RuntimeTurnErrorOptions
RuntimeTurnErrorSnapshot
RuntimeTurnEvent
RuntimeTurnOptions
RuntimeTurnRequest
RuntimeTurnResult
RuntimeUsage
RuntimeUsageCost
RuntimeUsageEvent
TurnAttachmentPart
TurnContentPart
TurnFilePart
TurnImagePart
TurnMessage
TurnRole
TurnTextPart
TurnToolCallPart
TurnToolResultPart
assertApprovalDecision
assertApprovalRequest
assertArtifactRef
assertAskUserAnswer
assertAskUserRequest
assertRouteIdentity
assertRuntimeNativeToolDescriptor
assertSafeHttpUrl
atomicReplaceOwnerPrivateFile
checkedFetch
configIssue
configPathToPointer
createOwnerPrivateFile
crossSlotReferenceSchema
defineChannelModule
defineConfigProvenance
defineMemoryModule
defineModuleSchema
defineRuntimeModule
ensureOwnerPrivateDirectory
envEligibleSchema
fetchBounded
inspectOwnerPrivateDirectory
inspectOwnerPrivateFile
isEnvEligibleSchema
isLiteralLoopbackHostname
isModuleConfigError
isRuntimeTurnError
isSecretSchema
parseApprovalDecision
parseApprovalRequest
parseArtifactRef
parseAskUserAnswer
parseAskUserRequest
parseModuleConfig
parseRouteIdentity
parseRuntimeNativeToolDescriptor
provenanceAt
readCrossSlotReference
readOwnerPrivateFile
snapshotRuntimeTurnError
```

### `@mono-agent/module-sdk/http`

```text
BoundedHttpResponse
CheckedFetchOptions
DEFAULT_HTTP_MAX_REDIRECTS
DEFAULT_HTTP_MAX_RESPONSE_BYTES
DEFAULT_HTTP_TIMEOUT_MS
HttpSafetyError
HttpSafetyErrorCode
assertSafeHttpUrl
checkedFetch
fetchBounded
isLiteralLoopbackHostname
```

### `@mono-agent/module-sdk/internal`

```text
ExportBatch
ExportRecord
ExportResult
Exporter
ExporterHost
ExporterModuleCreateContext
ExporterModuleDefinition
RESERVED_MODULE_KINDS
ReservedModuleDefinition
ReservedModuleKind
ReservedModuleManifest
Sandbox
SandboxCommand
SandboxHost
SandboxModuleCreateContext
SandboxModuleDefinition
SandboxResult
StateCompareAndSwapRequest
StateCompareAndSwapResult
StateDeleteArtifactRequest
StateDeleteRequest
StateExecution
StateExecutionRequest
StateHost
StateHostPresenceRequest
StateHostPresenceStatus
StateListArtifactsRequest
StateListArtifactsResult
StateListRequest
StateListResult
StateModuleCreateContext
StateModuleDefinition
StatePresenceListRequest
StatePresenceRecord
StatePresenceRemoveRequest
StatePresenceUpsertRequest
StatePutArtifactRequest
StateReadArtifactRequest
StateReadRequest
StateRecord
StateScanRequest
StateScanResult
StateStore
StateTransactionCheck
StateTransactionConflict
StateTransactionDelete
StateTransactionPut
StateTransactionRequest
StateTransactionResult
StateWriteRequest
StateWriteResult
Trigger
TriggerEvent
TriggerHost
TriggerModuleCreateContext
TriggerModuleDefinition
TriggerReceipt
```

### `@mono-agent/module-sdk/secure-fs`

```text
AtomicReplaceOwnerPrivateFileOptions
DEFAULT_OWNER_PRIVATE_READ_MAX_BYTES
OWNER_PRIVATE_DIRECTORY_MODE
OWNER_PRIVATE_FILE_MODE
OwnerPrivateOperationOptions
OwnerPrivatePathError
OwnerPrivatePathErrorCode
OwnerPrivatePathIdentity
ReadOwnerPrivateFileOptions
atomicReplaceOwnerPrivateFile
createOwnerPrivateFile
ensureOwnerPrivateDirectory
inspectOwnerPrivateDirectory
inspectOwnerPrivateFile
readOwnerPrivateFile
```

### `@mono-agent/module-sdk/testing`

```text
ChannelBehaviorComplianceOptions
ModuleComplianceError
ModuleComplianceOptions
assertChannelBehaviorCompliance
assertChannelInstanceCompliance
assertChannelModuleCompliance
assertMemoryInstanceCompliance
assertMemoryModuleCompliance
assertModuleDefinitionCompliance
assertMonoAgentModuleExport
assertRuntimeInstanceCompliance
assertRuntimeModuleCompliance
assertSchemaCompliance
```

## `@mono-agent/core`

### `@mono-agent/core`

```text
AgentAdmissionError
AgentAdmissionErrorCode
AgentApprovalAnswer
AgentApprovalAnswerStatus
AgentAskAnswer
AgentAskAnswerStatus
AgentConfig
AgentConfigError
AgentConfigExplanation
AgentConfigIssue
AgentConfigView
AgentConversationReplay
AgentConversationSummary
AgentHealth
AgentHost
AgentHostOptions
AgentHostStartInfo
AgentInspection
AgentInteractionEvidence
AgentLiveInput
AgentLiveInputStatus
AgentLoadOptions
AgentModuleCommandResult
AgentModuleDiagnostics
AgentModuleError
AgentPolicyConfig
AgentResponse
AgentResponseMessage
AgentRunAttemptEvidence
AgentRunEvent
AgentRunHistoryPage
AgentRunRecord
AgentRunStatus
AgentRunSummary
AgentSubmitInput
AgentTranscriptContentPart
AgentTranscriptEntry
AgentValidationResult
ConfigExplanationEntry
EnvReference
JsonSchema
LoadedAgentConfig
LoadedAgentModule
LoadedAuthoritySource
ModuleKind
ResolvedAgentPaths
RunExecutionError
RunExecutionErrorOptions
RunExecutionStatus
RuntimeRoute
SelectedModuleConfig
composeAgentConfigSchema
createAgentHost
diagnoseAgent
explainAgentConfig
inspectAgent
loadAgentConfig
runAgentModuleCommand
validateAgentConfig
```

## `@mono-agent/cli`

### `@mono-agent/cli`

```text
CliIo
CliSignal
CliSignalSource
runCli
```

## `@mono-agent/runtime-pi`

### `@mono-agent/runtime-pi`

```text
RuntimePiConfig
RuntimePiError
RuntimePiLocalProviderConfig
RuntimePiModelConfig
default
monoAgentModule
```

## `@mono-agent/runtime-claude`

### `@mono-agent/runtime-claude`

```text
RuntimeClaudeAuth
RuntimeClaudeConfig
RuntimeClaudeError
RuntimeClaudeMode
default
monoAgentModule
```

## `@mono-agent/runtime-codex`

### `@mono-agent/runtime-codex`

```text
RuntimeCodexConfig
RuntimeCodexError
default
monoAgentModule
```

## `@mono-agent/runtime-opencode`

### `@mono-agent/runtime-opencode`

```text
RuntimeOpenCodeConfig
RuntimeOpenCodeError
default
monoAgentModule
```

## `@mono-agent/channel-telegram`

### `@mono-agent/channel-telegram`

```text
CreateTelegramChannelOptions
DEFAULT_TELEGRAM_MAX_ATTACHMENT_BYTES
DEFAULT_TELEGRAM_POLL_SECONDS
DEFAULT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS
MAX_TELEGRAM_ATTACHMENT_BYTES
MAX_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS
TelegramBotClient
TelegramBotClientFactory
TelegramCallbackUpdate
TelegramChannel
TelegramConfig
TelegramConfigError
TelegramDelivery
TelegramEditMessageRequest
TelegramMessageUpdate
TelegramQuietHours
TelegramReactionConfig
TelegramRemoteAttachment
TelegramSendAttachmentRequest
TelegramSendMessageRequest
TelegramTranscriber
TelegramTranscriptionConfig
TelegramTransportConfig
TelegramUpdate
createTelegramBotApiClient
createTelegramChannel
createTelegramTranscriber
isWithinQuietHours
monoAgentModule
parseTelegramConfig
telegramConfigSchema
```

## `@mono-agent/channel-slack`

### `@mono-agent/channel-slack`

```text
CreateSlackChannelOptions
DEFAULT_SLACK_MAX_ATTACHMENT_BYTES
MAX_SLACK_ATTACHMENT_BYTES
MAX_SLACK_HOME_BUTTONS
MAX_SLACK_SHORTCUTS
SlackActionEvent
SlackApiClient
SlackApiClientFactory
SlackChannel
SlackConfig
SlackConfigError
SlackConfiguredAction
SlackDelivery
SlackFilePostRequest
SlackHomeActionEvent
SlackHomeButtonConfig
SlackHomeOpenedEvent
SlackHomeTabConfig
SlackHomeView
SlackMessageEvent
SlackPostRequest
SlackRemoteFile
SlackShortcutConfig
SlackShortcutEvent
SlackSocketEvent
SlackSocketEventHandler
SlackSocketFailure
SlackSocketFailureHandler
SlackSocketTransport
SlackSocketTransportFactory
createSlackChannel
createSlackSocketModeTransport
createSlackWebApiClient
monoAgentModule
parseSlackConfig
slackConfigSchema
```

## `@mono-agent/channel-webhook`

### `@mono-agent/channel-webhook`

```text
CreateWebhookChannelOptions
DEFAULT_MAX_BODY_BYTES
DEFAULT_MAX_RUN_MS
DEFAULT_MAX_STORED_REQUESTS
DEFAULT_RETENTION_MS
DEFAULT_WEBHOOK_HOST
DEFAULT_WEBHOOK_MODE
DEFAULT_WEBHOOK_PATH
DEFAULT_WEBHOOK_PORT
MAX_BODY_BYTES
MAX_RETENTION_MS
MAX_RUN_MS
MAX_STORED_REQUESTS
MAX_WEBHOOK_ROUTES
MAX_WEBHOOK_ROUTE_BYTES
WebhookChannel
WebhookChannelHealth
WebhookChannelStartInfo
WebhookConfig
WebhookConfigError
WebhookDelivery
WebhookInboundRequest
WebhookJsonObject
WebhookJsonValue
WebhookListenConfig
WebhookMode
WebhookModuleChannel
WebhookOutboundConfig
WebhookRequestStatus
WebhookRoute
WebhookSubmit
WebhookTerminalStatus
WebhookTurnResult
createWebhookChannel
isLoopbackHost
loadWebhookRoutesFromDirectory
monoAgentModule
parseWebhookConfig
parseWebhookMode
parseWebhookPath
parseWebhookRouteMarkdown
webhookConfigSchema
```

## `@mono-agent/channel-openai-api`

### `@mono-agent/channel-openai-api`

```text
CreateOpenAiApiServerOptions
DEFAULT_OPENAI_API_BASE_PATH
DEFAULT_OPENAI_API_HOST
DEFAULT_OPENAI_API_MAX_BODY_BYTES
DEFAULT_OPENAI_API_MAX_IMAGE_BYTES
DEFAULT_OPENAI_API_MAX_RESPONSE_BYTES
DEFAULT_OPENAI_API_MAX_RUN_MS
DEFAULT_OPENAI_API_MODEL_ID
DEFAULT_OPENAI_API_PORT
OpenAiApiConfig
OpenAiApiConfigError
OpenAiApiHealth
OpenAiApiModuleChannel
OpenAiApiServer
OpenAiApiStartInfo
OpenAiChatRequest
OpenAiDispatch
OpenAiRequestError
createOpenAiApiServer
isLoopbackHost
monoAgentModule
openAiApiConfigSchema
parseOpenAiApiConfig
parseOpenAiChatRequest
toChannelRequest
```

## `@mono-agent/channel-operator`

### `@mono-agent/channel-operator`

```text
CreateOperatorChannelOptions
DEFAULT_OPERATOR_HOST
DEFAULT_OPERATOR_PORT
MAX_OPERATOR_TOKEN_BYTES
MIN_OPERATOR_TOKEN_BYTES
OperatorAuthConfig
OperatorChannel
OperatorChannelConfig
OperatorChannelConfigError
OperatorChannelHealth
OperatorChannelStartInfo
OperatorDispatch
OperatorIdentityGrant
OperatorListenConfig
OperatorModuleChannel
createOperatorChannel
isLoopbackHost
monoAgentModule
operatorChannelConfigSchema
parseOperatorChannelConfig
```

## `@mono-agent/trigger-cron`

### `@mono-agent/trigger-cron`

```text
CreateCronTriggerOptions
CronClock
CronInvocationResult
CronInvocationSource
CronInvocationStatus
CronJob
CronNotifyDestination
CronOverflowPolicy
CronOverlapMode
CronTimerHandle
CronTrigger
DEFAULT_CRON_TIMEZONE
DEFAULT_MAX_QUEUE_DEPTH
DEFAULT_MAX_RUN_MS
MAX_CRON_CATCH_UP
MAX_CRON_JOBS
MAX_CRON_JOB_BYTES
TriggerCronConfig
TriggerCronConfigError
assertValidTimezone
createCronTrigger
cronIdempotencyKey
loadCronJobsFromDirectory
monoAgentModule
nextCronOccurrence
parseCronJobMarkdown
parseTriggerCronConfig
systemCronClock
triggerCronConfigSchema
```

## `@mono-agent/memory-local`

### `@mono-agent/memory-local`

```text
DEFAULT_EMBEDDING_BREAKER_FAILURES
DEFAULT_EMBEDDING_BREAKER_RESET_MS
DEFAULT_EMBEDDING_TIMEOUT_MS
DEFAULT_MEMORY_MAX_BYTES
DEFAULT_MEMORY_MAX_RECALL_RESULTS
DEFAULT_MEMORY_MAX_RECORDS
DEFAULT_MEMORY_MAX_TEXT_BYTES
DEFAULT_MEMORY_MAX_TOTAL_BYTES
DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_BYTES
DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS
DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS
DEFAULT_RUNTIME_CAPTURE_TIMEOUT_MS
MEMORY_LOCAL_DATABASE_FILENAME
MEMORY_LOCAL_FUTURE_LOG_FILENAME
MEMORY_LOCAL_INDEX_FILENAME
MEMORY_LOCAL_MARKER_FILENAME
MEMORY_LOCAL_WRITER_LEASE_FILENAME
MemoryEmbeddingProvider
MemoryLocal
MemoryLocalAudit
MemoryLocalAuditRequest
MemoryLocalBackupRequest
MemoryLocalBackupResult
MemoryLocalCaptureConfig
MemoryLocalConfig
MemoryLocalConsolidateRequest
MemoryLocalConsolidateResult
MemoryLocalEmbeddingsConfig
MemoryLocalError
MemoryLocalErrorCode
MemoryLocalForgetPreview
MemoryLocalModelRoute
MemoryLocalProjectionAudit
MemoryLocalProjectionStatus
MemoryLocalRebuildRequest
MemoryLocalRebuildResult
MemoryLocalRecallToolConfig
MemoryLocalRetryRequest
MemoryLocalRetryResult
OllamaMemoryEmbeddingProvider
OpenMemoryLocalOptions
default
memoryLocalJsonSchema
monoAgentModule
openMemoryLocal
parseMemoryLocalConfig
```

## `@mono-agent/state-local`

### `@mono-agent/state-local`

```text
ResolvedStateLocalConfig
ResolvedStateLocalRunsConfig
StateArtifactRef
StateDeleteArtifactRequest
StateListArtifactsRequest
StateListArtifactsResult
StateLocalConfig
StateLocalConfigError
StateLocalDiscoveryConfig
StateLocalError
StateLocalErrorCode
StateLocalMaintenanceRequest
StateLocalMaintenanceResult
StateLocalRunsConfig
StateLocalStore
StateLocalStoreHooks
StateLocalStoreOpenOptions
StatePresenceDescriptor
StatePresenceStatus
StatePresenceUpdate
StatePutArtifactRequest
StateReadArtifactRequest
default
monoAgentModule
parseStateLocalConfig
resolveStateLocalConfig
```

## `@mono-agent/exporter-otlp`

### `@mono-agent/exporter-otlp`

```text
FetchOtlpTransport
OtlpExporter
OtlpExporterConfig
OtlpExporterConfigError
OtlpExporterError
OtlpExporterErrorCode
OtlpExporterOptions
OtlpTransport
OtlpTransportRequest
OtlpTransportResponse
default
monoAgentModule
parseOtlpExporterConfig
```

## `@mono-agent/sandbox-srt`

### `@mono-agent/sandbox-srt`

```text
OpenSandboxSrtOptions
SandboxSrt
SandboxSrtConfig
SandboxSrtEnvironmentConfig
SandboxSrtError
SandboxSrtErrorCode
SandboxSrtFileConfig
SandboxSrtLimitsConfig
TrustedFile
default
monoAgentModule
openSandboxSrt
parseSandboxSrtConfig
sandboxSrtJsonSchema
```

## `@mono-agent/operator`

### `@mono-agent/operator`

```text
DiscoverOperatorsOptions
DiscoveredOperator
NormalizeDiscoveredOperatorOptions
OPERATOR_LIMITS
OPERATOR_PROTOCOL
OPERATOR_REGISTRY_SCHEMA
OPERATOR_ROUTES
OperatorAcceptedFrame
OperatorAction
OperatorActivityFrame
OperatorAsk
OperatorAskAnswerRequest
OperatorAskAnswerResponse
OperatorAskSnapshot
OperatorAskUserFrame
OperatorAttachment
OperatorCancelRequest
OperatorCancelResponse
OperatorCapabilities
OperatorCapabilitiesFrame
OperatorClient
OperatorClientError
OperatorClientLimits
OperatorClientOptions
OperatorCompletedFrame
OperatorConfigView
OperatorConversationList
OperatorConversationState
OperatorConversationStatus
OperatorConversationSummary
OperatorDeltaFrame
OperatorDirectory
OperatorDirectoryError
OperatorEntryClientOptions
OperatorErrorFrame
OperatorFrame
OperatorHealth
OperatorIdentityBindingError
OperatorIdentityBindingField
OperatorInfo
OperatorLiveInputRequest
OperatorLiveInputResponse
OperatorMessage
OperatorModel
OperatorProtocolError
OperatorQuestion
OperatorQuestionChoice
OperatorQuote
OperatorRegistryDescriptor
OperatorReplayResponse
OperatorRuntimeOverrideDecision
OperatorRuntimeOverrideIntent
OperatorRuntimeOverrideRejectionReason
OperatorStateError
OperatorStreamOptions
OperatorTerminalFrame
OperatorTurnRequest
OperatorUsage
OperatorUsageFrame
OperatorWireError
assertOperatorIdentity
availableOperatorActions
createOperatorClientForEntry
discoverOperators
evaluateOperatorRuntimeOverride
getDefaultOperatorRegistryDirectory
initialOperatorState
normalizeDiscoveredOperator
normalizeOperatorEndpoint
parseAskAnswerRequest
parseAskAnswerResponse
parseAskSnapshot
parseCancelRequest
parseCancelResponse
parseConfigView
parseConversationList
parseHealth
parseLiveInputRequest
parseLiveInputResponse
parseOperatorCapabilities
parseOperatorFrame
parseOperatorHealth
parseOperatorInfo
parseRegistryDescriptor
parseReplayResponse
parseTurnRequest
reduceOperatorFrame
reduceOperatorFrames
serializeOperatorFrame
```

### `@mono-agent/operator/testing`

```text
ASK_USER_TURN_FRAMES
FIXTURE_CAPABILITIES
MALFORMED_OPERATOR_FRAMES
MULTI_QUESTION_ASK_USER_ANSWER
MULTI_QUESTION_ASK_USER_TURN_FRAMES
VALID_OPERATOR_INFO
VALID_TURN_FRAMES
VALID_TURN_REQUEST
reduceFixture
```

## `@mono-agent/tui`

### `@mono-agent/tui`

```text
MonoAgentTuiApp
MonoAgentTuiAppOptions
ParseArgsResult
ParsedArgs
StartMonoAgentTuiHandle
StartMonoAgentTuiOptions
parseArgs
startMonoAgentTui
```

## `@mono-agent/web`

### `@mono-agent/web`

```text
AnswerWebAskInput
CreateWebThreadInput
LoadWebConfigOptions
OfferWebLiveInput
ParseWebConfigOptions
StartWebServerOptions
StartWebTurnInput
WEB_API_VERSION
WebAgent
WebAskAnswerResult
WebBootstrap
WebConfig
WebConfigView
WebHealthView
WebListenConfig
WebLiveInputResult
WebMessage
WebOperatorGateway
WebOperatorTurnInput
WebProactiveConversation
WebProductError
WebReplayView
WebServerHandle
WebThread
WebThreadDetail
WebTurnStatus
WebTurnTelemetry
loadWebConfig
parseWebConfig
startWebServer
webConfigJsonSchema
```

## `create-mono-agent`

### `create-mono-agent`

```text
COMPOSER_SKILL_TARGETS
ComposerSkillInstallResult
ComposerSkillTarget
CreateMonoAgentCliOptions
InstallComposerSkillOptions
InstallPackageManager
MinimalProjectOptions
PROJECT_TEMPLATES
PackageInstaller
ProjectIdentityOptions
ProjectTemplate
ProjectTemplateOptions
RenderedProjectFile
ScaffoldAgentOptions
ScaffoldError
ScaffoldResult
installComposerSkill
isProjectTemplate
renderMinimalProject
renderMultiRuntimeProject
renderPersonalProject
renderProject
runCreateMonoAgentCli
scaffoldAgent
```

## `@mono-agent/docs-mcp`

### `@mono-agent/docs-mcp`

```text
MONO_AGENT_DOCS_TOOL_NAME
MonoAgentDocsErrorCode
MonoAgentDocsErrorResult
MonoAgentDocsInput
MonoAgentDocsInternalLink
MonoAgentDocsNavigation
MonoAgentDocsNavigationAction
MonoAgentDocsReadAction
MonoAgentDocsReadResult
MonoAgentDocsScope
MonoAgentDocsSearchAction
MonoAgentDocsSearchHit
MonoAgentDocsSearchResult
createMonoAgentDocsMcpServer
```

## `@mono-agent/service-macos`

### `@mono-agent/service-macos`

```text
AgentPlanBinding
ApplyServiceMacosOptions
CommandResult
CommandRunOptions
CommandRunner
DEFAULT_LOG_MAX_BYTES
DEFAULT_LOG_RETAIN_FILES
InspectServiceMacosOptions
LAUNCHCTL_PATH
LoadedServiceMacosConfig
MAX_SERVICE_CONFIG_BYTES
PlanServiceMacosOptions
PlanServiceMacosRemovalOptions
ProtectedEnvironment
RecoverServiceMacosOptions
RemoveServiceMacosOptions
SERVICE_MACOS_CONFIG_VERSION
SERVICE_PLAN_SCHEMA_VERSION
ServiceFileIdentity
ServiceFileObservation
ServiceMacosCliOptions
ServiceMacosConfig
ServiceMacosConfigError
ServiceMacosDriftError
ServiceMacosLogsConfig
ServiceMacosMutationDisabledError
ServiceMacosObservation
ServiceMacosPlan
ServiceMacosPlanEntry
ServiceMacosRemovalPlan
ServiceMacosRemovalPlanEntry
ServiceMacosRuntimePaths
ServiceMacosServiceConfig
ServiceMacosTarget
ServicePlanAction
ServiceRemovalAction
ServiceRestartPolicy
ServiceRunnerBinding
ServiceSignal
ServiceSignalSource
applyServiceMacosPlan
assertRuntimePaths
defaultRuntime
fingerprintPlan
fingerprintRemovalPlan
inspectServiceMacos
loadProtectedEnvironment
loadServiceMacosConfig
parseEnvironment
parseServiceMacosConfig
planServiceMacos
planServiceMacosRemoval
processCommandRunner
recoverServiceMacosTransactions
removeServiceMacosPlan
renderServicePlist
runServiceMacosCli
serviceMacosConfigSchema
serviceTarget
```
