// SPDX-License-Identifier: MIT
import { StateLocalError } from "./errors.js";

export const STATE_INDEX_LOG_MAX_BYTES = 2_147_483_647;

const STATE_INDEX_LOG_MAX_FRAMES = 1_000_000;
const STATE_INDEX_LOG_COMPACT_RECLAIMABLE_BYTES = 256 * 1024 * 1024;
const STATE_INDEX_LOG_COMPACT_OBSOLETE_FRAMES = 100_000;

export interface IndexLogLimits {
  readonly maximumBytes: number;
  readonly maximumFrames: number;
  readonly compactAfterReclaimableBytes: number;
  readonly compactAfterObsoleteFrames: number;
}

/**
 * A capacity rejection proven to occur before descriptor-bound index mutation.
 * Callers may retry a smaller operation without reopening the lease.
 */
export class StateIndexCapacityError extends StateLocalError {
  constructor(message: string) {
    super("STATE_LIMIT_EXCEEDED", message);
  }
}

export function isStateIndexCapacityError(error: unknown): error is StateIndexCapacityError {
  return error instanceof StateIndexCapacityError;
}

export function indexCompactionStagingByteLimit(
  maximumBytes: number,
  frameOverhead: number,
): number {
  const stagingBytes = maximumBytes * 2 + frameOverhead;
  const absoluteMaximum = STATE_INDEX_LOG_MAX_BYTES * 2 + frameOverhead;
  if (
    !Number.isSafeInteger(stagingBytes)
    || !Number.isSafeInteger(frameOverhead)
    || frameOverhead < 0
    || stagingBytes > absoluteMaximum
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index staging bound is invalid.",
    );
  }
  return stagingBytes;
}

export function resolveIndexLogLimits(
  value: Partial<IndexLogLimits> | undefined,
): IndexLogLimits {
  const limits: IndexLogLimits = {
    maximumBytes: value?.maximumBytes ?? STATE_INDEX_LOG_MAX_BYTES,
    maximumFrames: value?.maximumFrames ?? STATE_INDEX_LOG_MAX_FRAMES,
    compactAfterReclaimableBytes:
      value?.compactAfterReclaimableBytes
      ?? STATE_INDEX_LOG_COMPACT_RECLAIMABLE_BYTES,
    compactAfterObsoleteFrames:
      value?.compactAfterObsoleteFrames
      ?? STATE_INDEX_LOG_COMPACT_OBSOLETE_FRAMES,
  };
  if (
    !Number.isSafeInteger(limits.maximumBytes)
    || limits.maximumBytes < 1_024
    || limits.maximumBytes > STATE_INDEX_LOG_MAX_BYTES
    || !Number.isSafeInteger(limits.maximumFrames)
    || limits.maximumFrames < 2
    || limits.maximumFrames > STATE_INDEX_LOG_MAX_FRAMES
    || !Number.isSafeInteger(limits.compactAfterReclaimableBytes)
    || limits.compactAfterReclaimableBytes < 1
    || limits.compactAfterReclaimableBytes >= limits.maximumBytes
    || !Number.isSafeInteger(limits.compactAfterObsoleteFrames)
    || limits.compactAfterObsoleteFrames < 1
    || limits.compactAfterObsoleteFrames >= limits.maximumFrames
  ) {
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      "Descriptor-bound state index test limits are invalid.",
    );
  }
  return limits;
}
