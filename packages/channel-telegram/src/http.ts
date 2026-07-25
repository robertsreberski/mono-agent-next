// SPDX-License-Identifier: MIT
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maxBytes, label);
  if (bytes.byteLength === 0) throw new Error(`${label} is empty.`);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds the byte limit.`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (total + next.value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the byte limit.`);
      }
      bytes.set(next.value, total);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.slice(0, total);
}
