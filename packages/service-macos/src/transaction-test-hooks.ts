export type ServiceMacosTransactionTestPoint =
  | "after-journal-prepared"
  | "after-prior-quarantined"
  | "after-desired-linked"
  | "after-desired-published"
  | "after-transaction-committed"
  | "after-restore-linked"
  | "before-stale-lock-quarantine"
  | "before-rollback";

export class SimulatedServiceMacosCrash extends Error {
  constructor(readonly point: ServiceMacosTransactionTestPoint) {
    super(`Simulated service-macos crash at ${point}.`);
    this.name = "SimulatedServiceMacosCrash";
  }
}

type Hook = (point: ServiceMacosTransactionTestPoint) => void | Promise<void>;

let installedHook: Hook | undefined;

/**
 * Package-internal deterministic crash hook. This module is not exported from
 * the package entrypoint and is used only by the package's adversarial tests.
 */
export function installServiceMacosTransactionTestHook(hook: Hook | undefined): void {
  installedHook = hook;
}

export async function runServiceMacosTransactionTestHook(
  point: ServiceMacosTransactionTestPoint,
): Promise<void> {
  await installedHook?.(point);
}

export function isSimulatedServiceMacosCrash(error: unknown): error is SimulatedServiceMacosCrash {
  return error instanceof SimulatedServiceMacosCrash;
}
