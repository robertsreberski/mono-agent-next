import {
  bootout,
  launchdServiceInfo,
} from "./launchd.js";
import type { LaunchctlResult, LaunchctlRunner } from "./launchd.js";

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

interface LifecyclePollDeps {
  readonly runner: LaunchctlRunner;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isAlive: (pid: number) => boolean;
}

export type UnloadLaunchdServiceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: LaunchctlResult };

export async function unloadLaunchdService(
  label: string,
  service: { readonly loaded: boolean; readonly pid?: number },
  ownedPids: readonly number[],
  deps: LifecyclePollDeps,
  uid: number,
  poll: PollOptions,
  beforeLoadedBootout?: () => Promise<void>,
): Promise<UnloadLaunchdServiceResult> {
  const observedPids = new Set(uniquePids([service.pid, ...ownedPids]));
  try {
    await beforeLoadedBootout?.();
  } catch (error) {
    return {
      ok: false,
      failure: { code: 1, stdout: "", stderr: maintenanceErrorMessage(error) },
    };
  }
  let current = await launchdServiceInfo(deps.runner, label, uid);
  if (current.pid !== undefined) observedPids.add(current.pid);
  const removed = current.loaded
    ? await bootout(deps.runner, label, uid)
    : { code: 0, stdout: "", stderr: "" };
  const stopped = await pollUntil(deps, poll, async () => {
    current = await launchdServiceInfo(deps.runner, label, uid);
    if (current.pid !== undefined) observedPids.add(current.pid);
    return !current.loaded && [...observedPids].every((pid) => !deps.isAlive(pid));
  });
  if (!stopped) {
    const livePids = [...observedPids].filter((pid) => deps.isAlive(pid));
    const detail = current.loaded
      ? `launchd still reports ${label} loaded after bootout`
      : `${label} pid(s) ${livePids.join(", ")} remained alive after bootout`;
    return { ok: false, failure: lifecycleFailure(removed, detail) };
  }
  return { ok: true };
}

export async function pollUntil(
  deps: Pick<LifecyclePollDeps, "now" | "sleep">,
  options: PollOptions,
  condition: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = deps.now() + options.timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(options.intervalMs);
  }
}

export function lifecycleFailure(result: LaunchctlResult, detail: string): LaunchctlResult {
  return {
    code: result.code === 0 ? 1 : result.code,
    stdout: result.stdout,
    stderr: [result.stderr.trim(), detail].filter((value) => value.length > 0).join("\n"),
  };
}

export function uniquePids(values: readonly (number | undefined)[]): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined && value > 0))];
}

export function maintenanceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const result = error as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
    const detail = [result.stderr, result.stdout]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim();
    if (detail !== undefined) return detail;
    if (typeof result.code === "number") return `launchctl exited ${result.code}`;
  }
  return String(error);
}
