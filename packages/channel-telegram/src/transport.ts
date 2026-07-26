// SPDX-License-Identifier: MIT
import {
  Agent,
  FormData as UndiciFormData,
  fetch as undiciFetch,
} from "undici";

export interface TelegramTransportDispatcher {
  readonly value: unknown;
  close(): Promise<void>;
}

export interface TelegramHttpTransport {
  readonly fetch: typeof fetch;
  createFormData(): FormData;
  createDispatcher?(ipFamily: 4 | 6): TelegramTransportDispatcher;
}

export type TelegramHttpTransportInput = TelegramHttpTransport | typeof fetch;

export function createTelegramWebTransport(
  fetchImpl: typeof fetch = globalThis.fetch,
): TelegramHttpTransport {
  const FormDataImpl = globalThis.FormData;
  return Object.freeze({
    fetch: fetchImpl,
    createFormData: () => new FormDataImpl(),
  });
}

export function createTelegramUndiciTransport(
  fetchImpl: typeof fetch = undiciFetch as unknown as typeof fetch,
): TelegramHttpTransport {
  return Object.freeze({
    fetch: fetchImpl,
    createFormData: () => new UndiciFormData() as unknown as FormData,
    createDispatcher(ipFamily: 4 | 6) {
      const dispatcher = new Agent({ connect: { family: ipFamily } });
      return Object.freeze({
        value: dispatcher,
        async close() { await dispatcher.close(); },
      });
    },
  });
}

export function resolveTelegramHttpTransport(
  ipFamily: 4 | 6 | undefined,
  input: TelegramHttpTransportInput | undefined,
): TelegramHttpTransport {
  const transport = input === undefined
    ? ipFamily === undefined
      ? createTelegramWebTransport()
      : createTelegramUndiciTransport()
    : typeof input === "function"
      ? createTelegramWebTransport(input)
      : input;
  if (ipFamily !== undefined && transport.createDispatcher === undefined) {
    throw new TypeError("Telegram transport.ipFamily requires a cohesive transport with a compatible dispatcher factory.");
  }
  return transport;
}
