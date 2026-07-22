import process from "node:process";
import { emitKeypressEvents } from "node:readline";

export function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/iu.test(error.message));
}

export function attachScopedKeypress(
  listener: (_value: string, key: { readonly name?: string; readonly ctrl?: boolean } | undefined) => void,
): () => void {
  if (!process.stdin.isTTY) return () => undefined;
  emitKeypressEvents(process.stdin);
  const input = process.stdin as typeof process.stdin & {
    readonly isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;
  input.setRawMode?.(true);
  input.resume();
  input.on("keypress", listener);
  return () => {
    input.off("keypress", listener);
    input.setRawMode?.(wasRaw);
    if (wasFlowing !== true) input.pause();
  };
}
