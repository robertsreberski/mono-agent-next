import { createHash } from "node:crypto";

import { StateLocalError } from "./errors.js";

export const INDEX_COMPACTION_CONTROL_BYTES = 96;
export const INDEX_GROWTH_MARKER_BYTES = 8 + 7 + 96;
export const INDEX_FRAME_COMMIT_MAGIC = Buffer.from("mas-commit-v2\n", "utf8");
export const INDEX_FRAME_FOOTER_BYTES = INDEX_FRAME_COMMIT_MAGIC.byteLength + 8;

const INDEX_COMPACTION_MAGIC = Buffer.from("mas-compact-v1\n", "utf8");
const INDEX_GROWTH_MAGIC = Buffer.from("masgrow1", "ascii");
const INDEX_GROWTH_CHECKSUM_DOMAIN =
  Buffer.from("mono-agent-index-growth-marker-v1\0", "ascii");
const RESERVED_BYTES = Buffer.alloc(8);
const INDEX_GROWTH_PAYLOAD_BYTES = 7 + 96;
const INDEX_GROWTH_PREFIX = Buffer.alloc(8 + 7 + 16);
INDEX_GROWTH_PREFIX.writeUInt32BE(INDEX_GROWTH_PAYLOAD_BYTES, 0);
INDEX_GROWTH_PREFIX.writeUInt32BE((~INDEX_GROWTH_PAYLOAD_BYTES) >>> 0, 4);
INDEX_GROWTH_PREFIX.writeUInt8(4, 8);
INDEX_GROWTH_PREFIX.writeUInt32BE(96, 11);
INDEX_GROWTH_MAGIC.copy(INDEX_GROWTH_PREFIX, 15);

export interface IndexCompactionDescriptor {
  readonly compactBytes: number;
  readonly compactDigest: Buffer;
  readonly compactFrames: number;
  readonly sourceBytes: number;
  readonly sourceDigest: Buffer;
  readonly sourceFrames: number;
}

export interface DecodedIndexCompaction extends IndexCompactionDescriptor {
  readonly outerOffset: number;
}

export function indexCompactionOuterOffset(
  sourceBytes: number,
  compactBytes: number,
): number {
  return compactBytes > sourceBytes
    ? Math.max(compactBytes, sourceBytes + INDEX_GROWTH_MARKER_BYTES)
    : sourceBytes;
}

export function encodeIndexCompactionControl(
  descriptor: IndexCompactionDescriptor,
): Buffer {
  const control = Buffer.alloc(INDEX_COMPACTION_CONTROL_BYTES);
  INDEX_COMPACTION_MAGIC.copy(control, 0);
  control.writeUInt32BE(descriptor.sourceBytes, 16);
  control.writeUInt32BE(descriptor.compactBytes, 20);
  control.writeUInt32BE(descriptor.sourceFrames, 24);
  control.writeUInt32BE(descriptor.compactFrames, 28);
  descriptor.sourceDigest.copy(control, 32);
  descriptor.compactDigest.copy(control, 64);
  return control;
}

export function decodeIndexCompactionControl(
  control: Buffer,
  outerOffset: number,
): DecodedIndexCompaction {
  if (
    control.byteLength !== INDEX_COMPACTION_CONTROL_BYTES
    || !control.subarray(0, INDEX_COMPACTION_MAGIC.byteLength)
      .equals(INDEX_COMPACTION_MAGIC)
    || control.readUInt8(INDEX_COMPACTION_MAGIC.byteLength) !== 0
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction control is invalid.",
    );
  }
  const sourceBytes = control.readUInt32BE(16);
  const compactBytes = control.readUInt32BE(20);
  const sourceFrames = control.readUInt32BE(24);
  const compactFrames = control.readUInt32BE(28);
  if (
    sourceBytes !== outerOffset
    || compactBytes < 26
    || compactBytes > sourceBytes
    || compactFrames > sourceFrames
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction bounds are invalid.",
    );
  }
  return {
    compactBytes,
    compactDigest: Buffer.from(control.subarray(64, 96)),
    compactFrames,
    outerOffset,
    sourceBytes,
    sourceDigest: Buffer.from(control.subarray(32, 64)),
    sourceFrames,
  };
}

export function encodeIndexGrowthMarker(
  descriptor: IndexCompactionDescriptor,
  outerOffset: number,
): Buffer {
  const marker = Buffer.alloc(INDEX_GROWTH_MARKER_BYTES);
  INDEX_GROWTH_PREFIX.copy(marker, 0);
  marker.writeUInt32BE(descriptor.sourceBytes, 31);
  marker.writeUInt32BE(outerOffset, 35);
  marker.writeUInt32BE(descriptor.compactBytes, 39);
  marker.writeUInt32BE(descriptor.sourceFrames, 43);
  descriptor.sourceDigest.copy(marker, 47);
  createHash("sha256")
    .update(INDEX_GROWTH_CHECKSUM_DOMAIN)
    .update(marker.subarray(15, 79))
    .digest()
    .copy(marker, 79);
  return marker;
}

export interface DecodedIndexGrowthMarker {
  readonly compactBytes: number;
  readonly outerOffset: number;
  readonly sourceBytes: number;
  readonly sourceDigest: Buffer;
  readonly sourceFrames: number;
}

interface IndexLogReader {
  readAt(position: number, length: number): Buffer;
}

export function hasCommittedIndexFrameAtEnd(
  log: IndexLogReader,
  frameOffset: number,
  end: number,
): boolean {
  if (end - frameOffset < INDEX_FRAME_FOOTER_BYTES) return false;
  const footer = log.readAt(end - INDEX_FRAME_FOOTER_BYTES, INDEX_FRAME_FOOTER_BYTES);
  if (!footer.subarray(0, INDEX_FRAME_COMMIT_MAGIC.byteLength)
    .equals(INDEX_FRAME_COMMIT_MAGIC)) return false;
  const lengths = footer.subarray(INDEX_FRAME_COMMIT_MAGIC.byteLength);
  const payloadBytes = lengths.readUInt32BE(0);
  if (lengths.readUInt32BE(4) !== ((~payloadBytes) >>> 0)) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index tail footer length complement is invalid.",
    );
  }
  return end - 8 - payloadBytes - 32 - INDEX_FRAME_FOOTER_BYTES === frameOffset;
}

export function hasIndexCommitFooterAtEnd(log: IndexLogReader, end: number): boolean {
  if (end < INDEX_FRAME_FOOTER_BYTES) return false;
  return log.readAt(
    end - INDEX_FRAME_FOOTER_BYTES,
    INDEX_FRAME_COMMIT_MAGIC.byteLength,
  ).equals(INDEX_FRAME_COMMIT_MAGIC);
}

export function isIndexGrowthMarkerPrefix(bytes: Buffer): boolean {
  if (bytes.byteLength > INDEX_GROWTH_MARKER_BYTES) return false;
  const fixedBytes = Math.min(bytes.byteLength, INDEX_GROWTH_PREFIX.byteLength);
  return bytes.subarray(0, fixedBytes).equals(INDEX_GROWTH_PREFIX.subarray(0, fixedBytes));
}

export function decodeIndexGrowthMarker(marker: Buffer): DecodedIndexGrowthMarker {
  if (
    marker.byteLength !== INDEX_GROWTH_MARKER_BYTES
    || !isIndexGrowthMarkerPrefix(marker)
    || !marker.subarray(23, 31).equals(RESERVED_BYTES)
    || !createHash("sha256")
      .update(INDEX_GROWTH_CHECKSUM_DOMAIN)
      .update(marker.subarray(15, 79))
      .digest()
      .equals(marker.subarray(79, 111))
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index growth marker is invalid.",
    );
  }
  const sourceBytes = marker.readUInt32BE(31);
  const outerOffset = marker.readUInt32BE(35);
  const compactBytes = marker.readUInt32BE(39);
  if (
    compactBytes <= sourceBytes
    || compactBytes > outerOffset
    || outerOffset < sourceBytes + INDEX_GROWTH_MARKER_BYTES
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index growth bounds are invalid.",
    );
  }
  return {
    compactBytes,
    outerOffset,
    sourceBytes,
    sourceDigest: Buffer.from(marker.subarray(47, 79)),
    sourceFrames: marker.readUInt32BE(43),
  };
}

export function inspectIncompleteIndexGrowth(
  log: IndexLogReader,
  frameOffset: number,
  end: number,
  frameCount: number,
  maximumBytes: number,
  outerFrameOverhead: number,
): DecodedIndexGrowthMarker | undefined {
  const availableBytes = Math.min(end - frameOffset, INDEX_GROWTH_MARKER_BYTES);
  const prefix = log.readAt(frameOffset, availableBytes);
  if (!prefix.subarray(0, Math.min(8, prefix.byteLength))
    .equals(INDEX_GROWTH_PREFIX.subarray(0, Math.min(8, prefix.byteLength)))) {
    return undefined;
  }
  if (prefix.byteLength > 8 && prefix.readUInt8(8) === 2) return undefined;
  if (!isIndexGrowthMarkerPrefix(prefix)) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index growth prefix is invalid.",
    );
  }
  if (availableBytes < INDEX_GROWTH_MARKER_BYTES) return {
    compactBytes: 0,
    outerOffset: 0,
    sourceBytes: frameOffset,
    sourceDigest: Buffer.alloc(0),
    sourceFrames: frameCount,
  };
  const marker = decodeIndexGrowthMarker(prefix);
  if (
    marker.sourceBytes !== frameOffset
    || marker.sourceFrames !== frameCount
    || marker.sourceBytes > maximumBytes
    || marker.compactBytes > maximumBytes
    || marker.outerOffset > maximumBytes + INDEX_GROWTH_MARKER_BYTES
    || end > marker.outerOffset + marker.compactBytes + outerFrameOverhead
    || !hashRange(log, 0, marker.sourceBytes).equals(marker.sourceDigest)
    || !rangeIsZero(
      log,
      marker.sourceBytes + INDEX_GROWTH_MARKER_BYTES,
      Math.min(end, marker.outerOffset),
    )
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index growth source is invalid.",
    );
  }
  return marker;
}

export function isProvenIncompleteIndexCompaction(
  log: IndexLogReader,
  frameOffset: number,
  end: number,
  payloadBytes: number,
  frameCount: number,
  maximumBytes: number,
): boolean {
  const metadataOffset = frameOffset + 8;
  const controlOffset = metadataOffset + 7;
  const valueBytes = payloadBytes - 7;
  if (valueBytes < INDEX_COMPACTION_CONTROL_BYTES) return false;
  const expectedMetadata = Buffer.alloc(7);
  expectedMetadata.writeUInt8(3, 0);
  expectedMetadata.writeUInt32BE(valueBytes, 3);
  const availableMetadataBytes = Math.min(end - metadataOffset, 7);
  if (availableMetadataBytes === 0) return payloadBytes > maximumBytes;
  const metadata = log.readAt(metadataOffset, availableMetadataBytes);
  if (metadata.readUInt8(0) !== 3) return false;
  if (!metadata.equals(expectedMetadata.subarray(0, availableMetadataBytes))) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction prefix is invalid.",
    );
  }
  if (availableMetadataBytes < 7) return true;
  if (end - controlOffset < INDEX_COMPACTION_CONTROL_BYTES) return true;
  const prepared = decodeIndexCompactionControl(
    log.readAt(controlOffset, INDEX_COMPACTION_CONTROL_BYTES),
    frameOffset,
  );
  if (
    prepared.sourceFrames !== frameCount
    || prepared.sourceBytes > maximumBytes
    || !hashRange(log, 0, prepared.sourceBytes).equals(prepared.sourceDigest)
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Descriptor-bound state index compaction source is invalid.",
    );
  }
  return true;
}

function hashRange(log: IndexLogReader, position: number, length: number): Buffer {
  const hash = createHash("sha256");
  let readBytes = 0;
  while (readBytes < length) {
    const chunkBytes = Math.min(length - readBytes, 64 * 1024);
    hash.update(log.readAt(position + readBytes, chunkBytes));
    readBytes += chunkBytes;
  }
  return hash.digest();
}

function rangeIsZero(log: IndexLogReader, start: number, end: number): boolean {
  let position = start;
  while (position < end) {
    const chunkBytes = Math.min(end - position, 64 * 1024);
    if (!log.readAt(position, chunkBytes).equals(Buffer.alloc(chunkBytes))) return false;
    position += chunkBytes;
  }
  return true;
}
