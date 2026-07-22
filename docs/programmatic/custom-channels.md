---
title: "Write your own channel adapter"
description: "Implement the ChannelDriver contract, load a channel package from config, or register a custom transport programmatically."
sidebar:
  order: 5
---

Use a custom channel when mono-agent does not ship your transport. You can load a package through `channels.plugins[]` or pass a driver directly to `startMonoAgentApp`. For built-in and bundled plugin options, see [Channels overview](/channels/).

## When you need a driver

The core drivers cover Telegram, Slack, Webhook, the OpenAI-compatible API, Cron, TUI, and Live. Bundled plugin-tier packages add WhatsApp and A2A. Write a `ChannelDriver` for an in-house message bus, SMS gateway, email poller, or another transport. Keep the driver thin: load config, start the transport, connect it to the responder, and return lifecycle controls.

The neutral contract lives in `@mono-agent/agent-contracts`, so a channel package does not depend on the app host. `@mono-agent/agent-app` re-exports host-bound aliases for the main driver and lifecycle types, with `MonoAgentConfig` bound as the core config type.

## Loading a package from config

The external-channel seam is only a loading mechanism. The app reads `channels.plugins[]`, resolves each `package` by name at startup, calls the package's `createChannelDriver(options)` export (or the package default export), and treats the returned object as a normal `ChannelDriver`. There is no plugin registry, version negotiation, lifecycle hook API, or extra contract beyond `ChannelDriver`.

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "label": "WhatsApp",
        "config": {
          "enabled": true,
          "allowedChatJids": ["123@s.whatsapp.net"]
        }
      }
    ]
  }
}
```

:::note[Installing the bundled plugin-tier packages]
`@mono-agent/whatsapp-adapter` and `@mono-agent/a2a-adapter` are **plugin-tier** packages: they publish to npm in the **same lockstep** as the core packages, so install the version that matches your `@mono-agent/agent-app`. Releases from before the extras rejoined the lockstep (npm `0.4.0`) predate this seam — they export no `createChannelDriver`, so `agent-app` reports `Channel plugin @mono-agent/whatsapp-adapter must export createChannelDriver(options) returning a ChannelDriver` and cannot load them (degradation is graceful — the rest of the host still runs), and they pull a now-retired internal settings dependency into your install tree. Upgrading the plugin to the current lockstep version fixes both. Each plugin's package README names the exact retired dependency.
:::

A package can expose a factory like this:

```ts
import type { ChannelDriver } from "@mono-agent/agent-contracts";

export interface MyChannelPluginOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: Record<string, unknown>;
}

interface MyChannelConfig {
  readonly enabled: boolean;
}

export function createChannelDriver(
  options: MyChannelPluginOptions = {},
): ChannelDriver<MyChannelConfig> {
  const id = options.id ?? "my-channel";
  const label = options.label ?? "My channel";
  const inlineConfig = options.config ?? {};

  return {
    id,
    label,
    async loadConfig({ env }) {
      return {
        enabled: inlineConfig.enabled === true || env.MONO_AGENT_MY_CHANNEL_ENABLED === "true",
      };
    },
    isConfigError(error) {
      return error instanceof Error && error.name === "MyChannelConfigError";
    },
    disabledReason(config) {
      return config.enabled ? undefined : `${label} is disabled.`;
    },
    async start(input) {
      return {
        summary: { id },
        stop: async () => {
          // stop your socket, poller, or subscription here
        },
      };
    },
  };
}
```

Missing packages, malformed exports, invalid plugin entries, and duplicate channel ids are reported as `waiting_for_config` validate/start sections so the rest of the host can still run. Choose an id that does not collide with a built-in or earlier plugin. The host checks both the id declared in config and the id returned by the factory; its reserved built-in id set is internal, not a public export.

## The ChannelDriver interface

```ts
import type {
  ChannelDriver,
  ChannelStartInput,
  RunningChannel,
  ChannelConfigInput,
  ChannelInteractionHub,
  NotifyDeliveryResult,
  NotifyDestination,
} from "@mono-agent/agent-contracts";
// or the same names from "@mono-agent/agent-app" (host-bound aliases)

interface ChannelDriver<TConfig = unknown, TCore = unknown> {
  readonly id: ChannelId;     // any string; built-ins use "telegram", "slack", …
  readonly label: string;     // human label for status output
  loadConfig(input: ChannelConfigInput): Promise<TConfig>;
  isConfigError(error: unknown): boolean;
  disabledReason?(config: TConfig): string | undefined;
  waitingReason?(config: TConfig): string | undefined;
  configView?(input: ChannelConfigInput): Promise<ChannelConfigViewSection>;
  configIssues?(config: TConfig): readonly string[];
  start(input: ChannelStartInput<TConfig, TCore>): Promise<RunningChannel>;
}
```

| Member | Contract |
|---|---|
| `id` | Identifies the channel in `channelStatus(id)` / `channelStatuses()` and its `channel:<id>` validate section. `ChannelId` is any string; choose a unique value such as `"discord"` or `"sms"`. |
| `label` | Display name shown in status / doctor output. |
| `loadConfig` | Receives `{ env, cwd, configPath }`. Read your section out of `mono-agent.config.json` (and env). Throw your own typed config error when the config is malformed. |
| `isConfigError` | Return `true` for your loader's own typed errors. The app treats those as `waiting_for_config` (incomplete) rather than a crash. |
| `disabledReason` | Return a string when the loaded config explicitly disables the channel (e.g. `enabled: false`) → status `disabled`. Return `undefined` to proceed. |
| `waitingReason` | Return a string when the config is enabled but still missing a required sub-section → status `waiting_for_config`. |
| `configView` | Optional. Compose a source-annotated config section (field-by-field `env`/`json`/`default` provenance, secrets as set/unset) for `mono-agent config` and the secret-placement warnings. Read-only. |
| `configIssues` | Optional. Structural problems in a loaded, enabled config (e.g. an invalid per-trigger model override). `validate` reports them as an `error`; `start` logs them and starts anyway. |
| `start` | Boot the transport and return a `RunningChannel`. |

`ChannelConfigInput` (the app-side alias is `MonoAgentAppConfigInput`) is exactly:

```ts
interface ChannelConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}
```

### ChannelStartInput and RunningChannel

`start` receives everything the transport needs, including the shared `AgentResponder` the app built from your runtime config:

```ts
interface ChannelStartInput<TConfig, TCore = unknown> {
  readonly config: TConfig;          // what loadConfig returned
  readonly coreConfig: TCore;        // MonoAgentConfig when run by the mono-agent app
  readonly responder: AgentResponder; // run the agent through this
  readonly cwd: string;
  readonly logger?: ChannelLogger;
  readonly onFailure: (reason: string) => void; // transport stopped with no recovery
  readonly onDegraded?: (reason: string) => void; // transport is self-recovering
  readonly onRecovered?: () => void;              // self-recovery completed
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean; readonly deliveryKey?: string },
  ) => Promise<NotifyDeliveryResult>;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly postedMessageIndexPath?: string;
  readonly interaction?: ChannelInteractionHub;
}

interface RunningChannel {
  readonly summary: Record<string, unknown>; // connection facts (URL, job count, ...)
  stop(): Promise<void>;
  dispose?(): Promise<void>;                  // set by the app, not the driver
}
```

Use `onFailure` when a transport dies after `start` and has no recovery path. The app marks the channel `failed` and disposes its responder. If the transport owns reconnection, call `onDegraded` while it recovers and `onRecovered` when service resumes; this keeps the responder alive and moves status from `running` to `degraded` and back.

:::note
Do not set `dispose` yourself — the app attaches responder/harness teardown so warm provider sessions are retired on stop/reload. Your job is to stop the transport in `stop()`.
:::

The optional fields are host-owned capability seams. Proactive trigger channels
use `notifyDestination` and `listNotifyDestinations`; thread-aware push channels
can use `postedMessageIndexPath`. Most custom transports need none of them.

### Supporting blocking AskUser

`interaction` is present when the host runs its interaction bridge. A channel
that supports structured `AskUser` round trips must:

1. Register one `ChannelInteractionSink` under its driver id. `presentAsk` and
   `updateAsk` render the supplied snapshot; `postStatus` renders keyed tool
   progress.
2. Before admitting an inbound text or button as a new agent turn, call
   `getPendingAsk(conversationId)`. If a snapshot exists, translate the input
   into complete `ChannelAskAnswer` values and call `submitAskAnswers` with the
   snapshot's exact `interactionId`.
3. Consume an accepted ask reply instead of calling `responder.respond`, so the
   blocked run resumes once. Route the transport's user-cancel action through
   `cancelAsks(conversationId)`.

The hub owns validation, expiry, and state. The adapter owns presentation and
pre-admission reply interception. If a driver does not register a sink, the
host does not claim that `AskUser` works on that channel.

### Minimal example

```ts
import {
  startMonoAgentApp,
  defaultChannelDrivers,
  type ChannelDriver,
} from "@mono-agent/agent-app";
import { BufferedMessageStream } from "@mono-agent/agent-contracts";

class SmsConfigError extends Error {}

const smsDriver: ChannelDriver<{ enabled: boolean; gatewayUrl?: string }> = {
  id: "sms", // any string works; the id keys status maps and the channel:sms validate section
  label: "SMS gateway",
  async loadConfig({ env }) {
    return {
      enabled: env.MONO_AGENT_SMS_ENABLED === "true",
      gatewayUrl: env.MONO_AGENT_SMS_GATEWAY_URL,
    };
  },
  isConfigError(error) {
    return error instanceof SmsConfigError;
  },
  disabledReason(config) {
    return config.enabled ? undefined : "SMS is disabled.";
  },
  waitingReason(config) {
    return config.gatewayUrl ? undefined : "SMS requires a gateway URL.";
  },
  async start(input) {
    if (!input.config.gatewayUrl) {
      throw new SmsConfigError("SMS requires a gateway URL.");
    }
    const poller = startSmsPoller({
      gatewayUrl: input.config.gatewayUrl,
      onInbound: async (msg) => {
        const stream = new BufferedMessageStream();
        const abort = new AbortController();
        const result = await input.responder.respond(
          {
            conversationId: msg.from,
            text: msg.body,
            abortSignal: abort.signal,
          },
          stream,
        );
        const finalText = result.text ?? stream.text;
        if (finalText.length > 0) await sendSms(msg.from, finalText);
      },
      onError: (err) => input.onFailure(err.message),
    });
    return {
      summary: { gatewayUrl: input.config.gatewayUrl },
      stop: async () => poller.stop(),
    };
  },
};

await startMonoAgentApp({
  drivers: [...defaultChannelDrivers(), smsDriver],
});
```

`defaultChannelDrivers()` returns every core built-in driver in startup/status order. App startup normally calls `resolveChannelDrivers(...)`, which returns those core drivers plus any configured `channels.plugins[]` packages. For a programmatic host, spread `defaultChannelDrivers()` and append yours; pass an empty-spread-plus-yours array to run **only** your driver. See [Composition](/programmatic/composition/) for assembling the responder/runtime that backs every channel.

## Overriding built-in stream and message text

You usually do not need a new driver to change behaviour — `defaultChannelDrivers(overrides)` and the per-channel factories (`createTelegramChannelDriver`, `createSlackChannelDriver`, …) accept transport overrides. These are the seams for swapping the bot/socket factory in tests. The stream and message-text knobs (welcome/help/error text, edit debounce, max chars, interim streaming) are baked into the built-in Telegram driver's start options; to change them, construct the underlying adapter yourself inside a thin custom driver and pass `stream` / `messages`.

The Telegram adapter's stream and message options:

| Option | Type | Default (app) | Effect |
|---|---|---|---|
| `stream.initialStatusText` | `string` | `"Agent is thinking..."` | Placeholder shown before the first token. |
| `stream.editDebounceMs` | `number` | `350` | Min gap between message edits while streaming. |
| `stream.maxMessageChars` | `number` | platform cap | Split threshold; must be an integer ≥ 32. |
| `stream.finalOnly` | `boolean` | `true` (bot) | `true` posts one final answer; **set `false` for live interim streaming** (edit-in-place as tokens arrive). |
| `messages.welcomeText` | `string` | "Agent is online…" | Shown on `/start`. |
| `messages.helpText` | `string` | "Send a message…" | Shown on `/help`. |
| `messages.unauthorizedText` | `string` | "This chat is not allowlisted…" | Sent to non-allowlisted chats. |
| `messages.errorText` | `string` or `(input) => string` | derived from the failure | Text on a failed run. A function receives the failure (kind/message/details) so you can special-case `usage_limit`, `cancelled`, etc. |

```ts
import {
  startMonoAgentApp,
  defaultChannelDrivers,
  type ChannelDriver,
} from "@mono-agent/agent-app";
import {
  loadTelegramAdapterConfig,
  startTelegramAdapter,
  TelegramAdapterConfigError,
  type TelegramAdapterConfig,
} from "@mono-agent/telegram-adapter";

const liveTelegram: ChannelDriver<TelegramAdapterConfig> = {
  id: "telegram",
  label: "Telegram",
  async loadConfig({ env, configPath }) {
    return loadTelegramAdapterConfig({ env, jsonPath: configPath });
  },
  isConfigError(error) {
    return error instanceof TelegramAdapterConfigError;
  },
  disabledReason(config) {
    return config.enabled ? undefined : "Telegram is disabled.";
  },
  async start(input) {
    const result = await startTelegramAdapter({
      botToken: input.config.botToken,
      allowedChatIds: [...input.config.allowedChatIds],
      allowAllChats: input.config.allowAllChats,
      responder: input.responder,
      stream: {
        finalOnly: false,        // live interim streaming
        editDebounceMs: 500,     // throttle edits harder
      },
      messages: {
        welcomeText: "Hi! Ask me anything.",
        helpText: "Just type. /cancel stops an in-flight reply.",
        errorText: ({ error }) =>
          `Sorry, that failed: ${error instanceof Error ? error.message : "unknown error"}`,
      },
      onPollingError: (error) =>
        input.onDegraded?.(error instanceof Error ? error.message : String(error)),
      onPollingRecovered: () => input.onRecovered?.(),
      ...(input.logger ? { logger: input.logger } : {}),
    });
    return { summary: {}, stop: () => result.stop() };
  },
};

// Run the built-ins except the default Telegram driver, plus this replacement.
const builtins = defaultChannelDrivers().filter((d) => d.id !== "telegram");
await startMonoAgentApp({ drivers: [...builtins, liveTelegram] });
```

Slack and WhatsApp expose their own message-stream modules with the same shape (`editDebounceMs`, `maxMessageChars`, `finalOnly`); build them the same way against `startSlackAdapter` / `startWhatsAppAdapter`.

:::caution
`finalOnly: false` produces many edit calls per response. Keep `editDebounceMs` at a few hundred ms or higher to stay under the transport's rate limits — the app default of 350 ms is a safe floor for Telegram.
:::

## Sending and delivery from inside a driver

Your driver talks to the agent through `input.responder`. For replying back into the channel, follow the same delivery contract the built-in channels use — including proactive/out-of-turn sends via the adapter send tools (`SlackSendMessage` / `TelegramSendMessage`). See [Delivery and send tools](/channels/delivery-and-send-tools/). For the underlying responder/runtime wiring, see [Composition](/programmatic/composition/); for structured-output and approval gating around runs, see [Approval and structured output](/programmatic/approval-and-structured-output/).

## Related pages

- [Channels overview](/channels/) — core transports and external channel packages.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — replying, proactive notify, allowlists.
- [Composition](/programmatic/composition/) — building the responder/runtime each driver receives.
- [Sessions and concurrency](/runtime/sessions-concurrency/) — how warm sessions and queued turns are managed behind a channel.
