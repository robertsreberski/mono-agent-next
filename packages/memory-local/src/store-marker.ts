// SPDX-License-Identifier: MIT
import type { FileHandle } from "node:fs/promises";

import { MemoryLocalError } from "./errors.js";
import type { PinnedSecureFile } from "./security.js";

export interface StoreMarker {
  readonly state: "initialized";
  readonly storeId: string;
}

export function parseMarker(bytes: Uint8Array): StoreMarker {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MemoryLocalError("corrupt_store", "Permanent first-run memory marker is not valid UTF-8.");
  }
  const match = /^initialized:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/u.exec(value);
  if (match === null) {
    if (/^initializing:/u.test(value)) {
      throw new MemoryLocalError(
        "incomplete_initialization",
        "Permanent first-run memory marker is still initializing; preserving it for operator inspection.",
      );
    }
    throw new MemoryLocalError("corrupt_store", "Permanent first-run memory marker has invalid exact bytes.");
  }
  return Object.freeze({ state: "initialized", storeId: match[1]! });
}

export function assertInitializedMarkerBytes(bytes: Uint8Array, marker: StoreMarker): void {
  assertMarkerBytes(bytes, "initialized", marker.storeId);
}

export function assertMarkerBytes(
  bytes: Uint8Array,
  state: "initializing" | "initialized",
  storeId: string,
): void {
  const canonical = Buffer.from(`${state}:${storeId}\n`, "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    throw new MemoryLocalError("corrupt_store", "Permanent first-run memory marker bytes are not canonical.");
  }
}

export async function writeMarkerState(
  handle: FileHandle,
  state: "initializing" | "initialized",
  storeId: string,
): Promise<void> {
  const bytes = Buffer.from(`${state}:${storeId}\n`, "utf8");
  const result = await handle.write(bytes, 0, bytes.byteLength, 0);
  if (result.bytesWritten !== bytes.byteLength) {
    throw new MemoryLocalError("incomplete_initialization", "First-run marker write was incomplete.");
  }
  await handle.truncate(bytes.byteLength);
  await handle.sync();
}

export async function readPinnedBytes(
  file: PinnedSecureFile,
  maximumBytes: number,
): Promise<Uint8Array> {
  await file.verify();
  const bytes = await readHandleBytes(file.handle, maximumBytes);
  await file.verify();
  return bytes;
}

export async function readHandleBytes(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  const stat = await handle.stat();
  if (stat.size < 0 || stat.size > maximumBytes) {
    throw new MemoryLocalError("unsafe_store", "Memory marker exceeds its byte bound.");
  }
  const output = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < output.byteLength) {
    const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== output.byteLength) {
    throw new MemoryLocalError("unsafe_store", "Memory marker changed while reading.");
  }
  return Uint8Array.from(output);
}
