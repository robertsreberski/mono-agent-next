// SPDX-License-Identifier: MIT
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function abortError(message = "operation aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export async function waitForValueWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw signal.reason instanceof Error ? signal.reason : abortError();
  }
  let listener!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

export async function withTimeoutSignal<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T> | undefined,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  label: string,
): Promise<T | undefined> {
  const timeoutController = new AbortController();
  const signal = parent === undefined
    ? timeoutController.signal
    : AbortSignal.any([parent, timeoutController.signal]);
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  const timeout = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
  const running = Promise.resolve().then(() => operation(signal));
  try {
    return await waitForValueWithAbort(running, signal);
  } finally {
    clearTimeout(timeout);
  }
}

export class HostLifecycleCalls {
  constructor(
    readonly timeoutMs: number,
    readonly hostSignal: AbortSignal,
  ) {}

  run<T>(
    label: string,
    operation: (signal: AbortSignal) => T | PromiseLike<T> | undefined,
  ): Promise<T | undefined> {
    return withTimeoutSignal(operation, this.timeoutMs, this.hostSignal, label);
  }

  cleanup<T>(
    label: string,
    operation: (signal: AbortSignal) => T | PromiseLike<T> | undefined,
  ): Promise<T | undefined> {
    return withTimeoutSignal(operation, this.timeoutMs, undefined, label);
  }
}

export class TurnSemaphore {
  #active = 0;
  readonly #waiters: {
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
    readonly signal: AbortSignal;
  }[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      this.#waiters.push(waiter);
      signal.addEventListener(
        "abort",
        () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#active -= 1;
      return;
    }
    if (next.signal.aborted) {
      this.#release();
      return;
    }
    next.resolve(() => this.#release());
  }
}
