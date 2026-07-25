// SPDX-License-Identifier: MIT
import type { OwnerPrivatePathIdentity } from "@mono-agent/module-sdk";

import type { SlackSocketEvent } from "./socket.js";

export function cloneEvent(event: SlackSocketEvent): SlackSocketEvent {
  if (event.kind === "message") {
    return Object.freeze({
      ...event,
      files: Object.freeze(event.files.map((file) => Object.freeze({ ...file }))),
    });
  }
  return Object.freeze({ ...event });
}

export function validateEnvelopeId(value: string): void {
  if (!validEnvelopeId(value)) {
    throw new TypeError("Slack envelope id must be 1-512 printable characters.");
  }
}

export function validEnvelopeId(value: unknown): value is string {
  return boundedString(value, 512) && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validTimestamp(value: unknown): value is string {
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

export function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sameIdentity(
  left: OwnerPrivatePathIdentity,
  right: OwnerPrivatePathIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Slack durable inbox operation aborted.");
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
