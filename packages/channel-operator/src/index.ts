import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  MODULE_API_VERSION,
  defineChannelModule,
  provenanceAt,
  type Channel,
  type ChannelDeliveryResult,
  type ChannelModuleCreateContext,
  type ChannelOutboundMessage,
  type JsonObject,
  type JsonValue,
  type ModuleHealth,
  type ModuleHealthContext,
  type ModuleStartContext,
  type ModuleStopContext,
} from "@mono-agent/module-sdk";

import {
  operatorChannelConfigSchema,
  type OperatorChannelConfig,
} from "./config.js";
import {
  createOperatorChannel,
  type OperatorChannel,
  type OperatorChannelStartInfo,
  type OperatorIdentityGrant,
} from "./server.js";

const PACKAGE_NAME = "@mono-agent/channel-operator";
const PACKAGE_VERSION = "0.15.0";
const MAX_DELIVERY_RECEIPTS = 1_000;
const MAX_PROACTIVE_TEXT_CHARACTERS = 262_144;
const MAX_METADATA_BYTES = 65_536;
const MAX_METADATA_ITEMS = 2_048;
const MAX_METADATA_DEPTH = 16;

interface OperatorDeliveryReceipt {
  readonly fingerprint: string;
  readonly promise: Promise<ChannelDeliveryResult>;
  result?: ChannelDeliveryResult;
}

export interface OperatorModuleChannel extends Channel {
  readonly endpoint: string | undefined;
  readonly startInfo: OperatorChannelStartInfo | undefined;
}

export const monoAgentModule = defineChannelModule({
  manifest: {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    apiVersion: MODULE_API_VERSION,
    kind: "channel",
    responsibility: "Serves one selected agent through the authenticated shared operator protocol.",
    capabilities: ["operator.identity.v1"],
  },
  schema: operatorChannelConfigSchema,
  create: createOperatorModuleChannel,
});

function createOperatorModuleChannel(
  context: ChannelModuleCreateContext<OperatorChannelConfig>,
): OperatorModuleChannel {
  const identity = context.host.getCapability<OperatorIdentityGrant>("operator.identity.v1");
  if (identity === undefined) throw new Error("channel-operator requires the declared operator.identity.v1 host grant.");
  const transport: OperatorChannel = createOperatorChannel({
    config: context.config,
    identity,
    dispatch: (request, reply) => context.host.dispatch(request, reply),
    host: context.host,
  });
  const capabilities = Object.freeze({
    attachments: true,
    liveInput: context.host.offerLiveInput !== undefined,
    askUser: context.host.answerAsk !== undefined,
    approvals: false,
    proactive: context.host.openConversation !== undefined,
    runtimeControl: true,
    verbatim: false,
    cancellation: true,
  });
  const deliveryReceipts = new Map<string, OperatorDeliveryReceipt>();
  let deliveryCapacityExhausted = false;

  const start = async (startContext: ModuleStartContext): Promise<void> => {
    throwIfAborted(startContext.signal, "Operator channel start was aborted.");
    const info = await transport.start();
    context.logger.info("Operator channel listening.", {
      instanceId: context.instanceId,
      endpoint: info.endpoint,
      authRequired: true,
      protocol: info.protocol,
    });
  };

  const stop = async (_stopContext: ModuleStopContext): Promise<void> => {
    await transport.stop();
  };

  const health = async (_healthContext: ModuleHealthContext): Promise<ModuleHealth> => {
    const snapshot = transport.health();
    return {
      status: deliveryCapacityExhausted
        ? "degraded"
        : snapshot.status === "healthy"
          ? "healthy"
        : snapshot.status === "degraded"
          ? "degraded"
          : "unknown",
      checkedAt: new Date().toISOString(),
      ...(snapshot.message !== undefined
        ? { summary: snapshot.message }
        : deliveryCapacityExhausted
          ? { summary: "Operator delivery receipt capacity is exhausted." }
          : {}),
      details: {
        activeTurns: snapshot.activeTurns,
        deliveryReceiptCapacityExhausted: deliveryCapacityExhausted,
        ...(transport.endpoint === undefined ? {} : { endpoint: transport.endpoint }),
      },
    };
  };

  return {
    capabilities,
    get endpoint(): string | undefined {
      return transport.endpoint;
    },
    get startInfo(): OperatorChannelStartInfo | undefined {
      return transport.startInfo;
    },
    readHostPresence() {
      const info = transport.startInfo;
      if (info === undefined) return undefined;
      const tokenEnvironment = provenanceAt(context.provenance, ["auth", "token"])?.environmentName;
      if (tokenEnvironment === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnvironment)) {
        throw new Error("Operator discovery requires auth.token environment provenance.");
      }
      return {
        operatorRegistry: {
          schema: "mono-agent.operator-registry-details.v1",
          agent: identity.agent,
          operator: { endpoint: info.endpoint, tokenEnvironment },
          process: { pid: identity.process.pid, startedAt: info.startedAt },
          capabilities: {
            attachments: capabilities.attachments,
            liveInput: capabilities.liveInput,
            askUser: capabilities.askUser,
            cancellation: capabilities.cancellation,
            quotes: context.host.readReplay !== undefined,
            runtimeOverrides: capabilities.runtimeControl,
            proactive: capabilities.proactive,
            configView: true,
            replay: true,
            health: true,
          },
        },
      };
    },
    start,
    async drain(): Promise<void> {
      await transport.stop();
    },
    stop,
    health,
    ...(context.host.openConversation === undefined ? {} : {
      deliver(value, signal): Promise<ChannelDeliveryResult> {
        const prepared = prepareOperatorDelivery(value);
        if ("failure" in prepared) return Promise.resolve(prepared.failure);
        const message = prepared.message;
        const fingerprint = deliveryFingerprint(message);
        const existing = deliveryReceipts.get(message.idempotencyKey);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return Promise.resolve({
              status: "failed",
              idempotencyKey: message.idempotencyKey,
              diagnostic: {
                code: "operator_proactive_idempotency_conflict",
                severity: "error",
                message: "The operator delivery idempotency key was reused for a different payload.",
              },
            });
          }
          if (existing.result?.status === "delivered" || existing.result?.status === "duplicate") {
            return Promise.resolve({
              ...existing.result,
              status: "duplicate",
              idempotencyKey: message.idempotencyKey,
            });
          }
          return existing.promise;
        }
        if (deliveryReceipts.size >= MAX_DELIVERY_RECEIPTS) {
          deliveryCapacityExhausted = true;
          return Promise.resolve({
            status: "failed",
            idempotencyKey: message.idempotencyKey,
            diagnostic: {
              code: "operator_proactive_receipt_capacity",
              severity: "error",
              message: "Operator delivery receipt capacity is exhausted; restart-safe Core delivery authority is required.",
            },
          });
        }
        let receipt: OperatorDeliveryReceipt;
        const execution = (async (): Promise<ChannelDeliveryResult> => {
          try {
            const opened = await context.host.openConversation!({ initialText: message.text, metadata: { ...(message.metadata ?? {}), source: "operator-proactive", idempotencyKey: message.idempotencyKey }, signal });
            return { status: "delivered", idempotencyKey: message.idempotencyKey, messageId: opened.conversationId };
          } catch {
            return { status: "unknown", idempotencyKey: message.idempotencyKey, diagnostic: { code: "operator_proactive_unknown", severity: "error", message: "Operator proactive delivery outcome is unknown." } };
          }
        })().then((result) => {
          receipt.result = result;
          return result;
        });
        receipt = { fingerprint, promise: execution };
        deliveryReceipts.set(message.idempotencyKey, receipt);
        return execution;
      },
    }),
  };
}

function throwIfAborted(signal: AbortSignal, message: string): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

function deliveryFingerprint(message: Parameters<NonNullable<Channel["deliver"]>>[0]): string {
  const encoded = JSON.stringify({
    conversationId: message.conversationId,
    text: message.text,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      sha256: createHash("sha256").update(attachment.data).digest("hex"),
    })),
    replyToMessageId: message.replyToMessageId ?? null,
    metadata: message.metadata ?? null,
  }, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
  return createHash("sha256").update(encoded).digest("hex");
}

function prepareOperatorDelivery(
  value: ChannelOutboundMessage,
):
  | { readonly message: ChannelOutboundMessage }
  | { readonly failure: ChannelDeliveryResult } {
  try {
    const input = ownDataRecord(value, "Operator outbound message", [
      "conversationId",
      "text",
      "attachments",
      "replyToMessageId",
      "idempotencyKey",
      "metadata",
    ]);
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "idempotencyKey",
      512,
    );
    if (input.text === "") {
      return {
        failure: {
          status: "failed",
          idempotencyKey,
          diagnostic: {
            code: "operator_proactive_empty",
            severity: "error",
            message: "Operator proactive delivery requires text.",
          },
        },
      };
    }
    const attachments = input.attachments;
    if (attachments !== undefined) {
      if (utilTypes.isProxy(attachments)
        || !Array.isArray(attachments)
        || Object.getPrototypeOf(attachments) !== Array.prototype) {
        throw new TypeError("attachments must be one ordinary array");
      }
      assertDenseDataArray(attachments, "attachments");
      if (attachments.length > 0) {
        return {
          failure: {
            status: "failed",
            idempotencyKey,
            diagnostic: {
              code: "operator_proactive_attachments_unsupported",
              severity: "error",
              message: "Operator proactive attachment delivery is unsupported.",
            },
          },
        };
      }
    }
    const text = boundedText(
      input.text,
      "text",
      MAX_PROACTIVE_TEXT_CHARACTERS,
    );
    const conversationId = boundedText(
      input.conversationId,
      "conversationId",
      4_096,
      true,
    );
    const replyToMessageId = input.replyToMessageId === undefined
      ? undefined
      : boundedText(input.replyToMessageId, "replyToMessageId", 512);
    const metadata = input.metadata === undefined
      ? undefined
      : snapshotMetadata(input.metadata);
    return Object.freeze({
      message: Object.freeze({
        conversationId,
        text,
        idempotencyKey,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        ...(metadata === undefined ? {} : { metadata }),
      }),
    });
  } catch {
    return {
      failure: {
        status: "failed",
        idempotencyKey: safeIdempotencyKey(value),
        diagnostic: {
          code: "operator_proactive_invalid",
          severity: "error",
          message: "Operator proactive delivery is invalid or exceeds a configured bound.",
        },
      },
    };
  }
}

function snapshotMetadata(value: unknown): JsonObject {
  const state = {
    items: 0,
    bytes: 0,
    seen: new WeakSet<object>(),
  };
  const snapshot = snapshotJson(value, state, 0);
  if (!isRecord(snapshot)) throw new TypeError("metadata must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_METADATA_BYTES) {
    throw new TypeError("metadata exceeds the delivery bound");
  }
  return snapshot as JsonObject;
}

function snapshotJson(
  value: unknown,
  state: { items: number; bytes: number; seen: WeakSet<object> },
  depth: number,
): JsonValue {
  state.items += 1;
  if (state.items > MAX_METADATA_ITEMS || depth > MAX_METADATA_DEPTH) {
    throw new TypeError("metadata exceeds the delivery structure bound");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("metadata number is invalid");
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_METADATA_BYTES) {
      throw new TypeError("metadata exceeds the delivery byte bound");
    }
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("metadata contains a non-JSON value");
  }
  if (state.seen.has(value)) throw new TypeError("metadata contains a cycle");
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || value.length > MAX_METADATA_ITEMS) {
      throw new TypeError("metadata array is invalid");
    }
    assertDenseDataArray(value, "metadata array");
    const output = value.map((entry) =>
      snapshotJson(entry, state, depth + 1));
    state.seen.delete(value);
    return Object.freeze(output);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("metadata object is invalid");
  }
  const output: Record<string, JsonValue> =
    Object.create(null) as Record<string, JsonValue>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string"
      || key === "__proto__"
      || key === "prototype"
      || key === "constructor") {
      throw new TypeError("metadata key is invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable) {
      throw new TypeError("metadata property is invalid");
    }
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > MAX_METADATA_BYTES) {
      throw new TypeError("metadata exceeds the delivery byte bound");
    }
    output[key] = snapshotJson(descriptor.value, state, depth + 1);
  }
  state.seen.delete(value);
  return Object.freeze(output);
}

function ownDataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const fields = new Set(allowed);
  const output: Record<string, unknown> =
    Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.has(key)) {
      throw new TypeError(`${label} contains an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function assertDenseDataArray(value: readonly unknown[], label: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError(`${label} must contain only dense data entries`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only dense data entries`);
    }
  }
}

function boundedText(
  value: unknown,
  label: string,
  maxCharacters: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maxCharacters
    || value.includes("\0")) {
    throw new TypeError(`${label} exceeds its delivery bound`);
  }
  return value;
}

function safeIdempotencyKey(value: unknown): string {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    return "invalid";
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "idempotencyKey");
  return descriptor !== undefined
    && "value" in descriptor
    && typeof descriptor.value === "string"
    && descriptor.value.length > 0
    && descriptor.value.length <= 512
    && !descriptor.value.includes("\0")
      ? descriptor.value
      : "invalid";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./config.js";
export * from "./server.js";
