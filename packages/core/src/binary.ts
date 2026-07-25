// SPDX-License-Identifier: MIT
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const TYPED_ARRAY_TAG_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;

/**
 * Clone bytes through intrinsic typed-array slots.
 *
 * Own/subclass accessors cannot under-report the byte length, proxies have no
 * typed-array internal slots, and detached or changing views fail closed.
 */
export function cloneIntrinsicUint8Array(
  value: unknown,
  path: string,
  maxBytes: number,
): Uint8Array {
  try {
    if (
      !Number.isSafeInteger(maxBytes)
      || maxBytes < 0
      || TYPED_ARRAY_BUFFER_GETTER === undefined
      || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
      || TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined
      || TYPED_ARRAY_TAG_GETTER === undefined
      || TYPED_ARRAY_TAG_GETTER.call(value) !== "Uint8Array"
    ) {
      throw new TypeError("Expected Uint8Array");
    }
    const beforeLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
    const beforeOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value) as unknown;
    const buffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    if (
      !Number.isSafeInteger(beforeLength)
      || (beforeLength as number) < 0
      || !Number.isSafeInteger(beforeOffset)
      || (beforeOffset as number) < 0
      || (
        !(buffer instanceof ArrayBuffer)
        && !(typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer)
      )
    ) {
      throw new TypeError("Invalid Uint8Array internals");
    }
    if ((beforeLength as number) > maxBytes) {
      throw new RangeError(`${path} exceeds the ${String(maxBytes)}-byte boundary`);
    }
    const source = new Uint8Array(
      buffer as ArrayBufferLike,
      beforeOffset as number,
      beforeLength as number,
    );
    const copy = new Uint8Array(source);
    const afterLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
    const afterOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value) as unknown;
    const afterBuffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    if (
      afterLength !== beforeLength
      || afterOffset !== beforeOffset
      || afterBuffer !== buffer
      || copy.byteLength !== beforeLength
    ) {
      throw new TypeError("Uint8Array changed while being copied");
    }
    return copy;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new TypeError(`${path} must be stable Uint8Array byte data`, { cause: error });
  }
}
