export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function settleWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operator turn aborted.");
}
