import { bootstrap, launchdServiceInfo } from "./launchd.js";
import type { LaunchdLogInspection, LaunchdLogMaintenanceIntent } from "./launchd-logs.js";
import {
  lifecycleFailure,
  maintenanceErrorMessage,
  pollUntil,
  uniquePids,
  unloadLaunchdService,
} from "./background-lifecycle-utils.js";
import type { PollOptions } from "./background-lifecycle-utils.js";
import type { BackgroundDeps, BackgroundLifecycleTarget } from "./background.js";
import * as ui from "./ui.js";

/** Run one authenticated, crash-recoverable stopped-writer log rotation pass. */
export async function maintainLaunchdLogsOperation(
  target: BackgroundLifecycleTarget,
  deps: BackgroundDeps,
  poll: PollOptions,
): Promise<number> {
  const release = await deps.acquireLifecycleLock(target);
  if (release === undefined) return 0;
  try {
    const uid = deps.getuid();
    const service = await launchdServiceInfo(deps.runner, target.label, uid);

    let inspection: LaunchdLogInspection;
    try {
      inspection = await deps.inspectLaunchdLogs(target.paths);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "inspect launchd logs", error);
      return 1;
    }
    let maintenanceIntent: LaunchdLogMaintenanceIntent | undefined;
    try {
      maintenanceIntent = await deps.readLaunchdLogMaintenanceIntent(target.paths);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "read durable launchd-log maintenance intent", error);
      return 1;
    }
    if (inspection.pendingMaintenance && maintenanceIntent === undefined) {
      reportMaintenanceFailure(
        target,
        deps,
        "read durable launchd-log maintenance intent",
        new Error("The maintenance marker disappeared after inventory."),
      );
      return 1;
    }
    if (!service.loaded && maintenanceIntent === undefined) return 0;

    let originalPlistIdentity: string;
    try {
      originalPlistIdentity = await deps.verifyLaunchdPlist(target.paths.plistPath);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "verify the existing main LaunchAgent", error);
      return 1;
    }
    if (maintenanceIntent !== undefined
      && (maintenanceIntent.label !== target.label
        || maintenanceIntent.plistFingerprint !== originalPlistIdentity)) {
      reportMaintenanceFailure(
        target,
        deps,
        "authenticate durable launchd-log maintenance intent",
        new Error("The pending intent does not match the exact main LaunchAgent definition."),
      );
      return 1;
    }
    if (maintenanceIntent?.phase === "stopping" && !service.loaded) {
      reportMaintenanceFailure(
        target,
        deps,
        "recover interrupted launchd-log maintenance",
        new Error("The prior maintainer did not durably prove every old writer PID dead; refusing rotation."),
      );
      return 1;
    }
    if (maintenanceIntent?.phase === "restoring") {
      const replacement = await launchdServiceInfo(deps.runner, target.label, uid);
      if (!replacement.loaded || replacement.pid === undefined || !deps.isAlive(replacement.pid)) {
        reportMaintenanceFailure(
          target,
          deps,
          "recover interrupted launchd-log restoration",
          new Error("The replacement writer identity was lost before live-worker proof; refusing stale rotation authority."),
        );
        return 1;
      }
      try {
        await deps.clearLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
      } catch (error) {
        reportMaintenanceFailure(target, deps, "clear recovered launchd-log restoration intent", error);
        return 1;
      }
      return 0;
    }
    if (maintenanceIntent?.phase === "stopped" && service.loaded) {
      reportMaintenanceFailure(
        target,
        deps,
        "recover interrupted launchd-log maintenance",
        new Error("launchd reports a writer loaded after durable stopped-writer proof; refusing rotation."),
      );
      return 1;
    }

    if (!inspection.canMaintain) {
      deps.stderr(ui.errorLine(`Scheduled log maintenance refused unsafe paths for ${target.label}.`));
      for (const issue of inspection.issues) deps.stderr(ui.style.dim(issue) + "\n");
      return 1;
    }
    if (!inspection.needsMaintenance && maintenanceIntent === undefined) return 0;

    if (maintenanceIntent === undefined) {
      maintenanceIntent = {
        version: 1,
        phase: "stopping",
        label: target.label,
        plistFingerprint: originalPlistIdentity,
      };
      try {
        await deps.beginLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
      } catch (error) {
        reportMaintenanceFailure(target, deps, "publish durable launchd-log maintenance intent", error);
        return 1;
      }
    }

    if (maintenanceIntent.phase === "stopping") {
      const stopped = await unloadLaunchdService(
        target.label,
        service,
        uniquePids([service.pid]),
        deps,
        uid,
        poll,
      );
      if (!stopped.ok) {
        reportMaintenanceFailure(target, deps, "prove the launchd log writer stopped", stopped.failure);
        return 1;
      }
      try {
        maintenanceIntent = await deps.markLaunchdLogMaintenanceStopped(target.paths, maintenanceIntent);
      } catch (error) {
        reportMaintenanceFailure(target, deps, "record durable stopped-writer proof", error);
        return 1;
      }
    } else {
      const current = await launchdServiceInfo(deps.runner, target.label, uid);
      if (current.loaded || (current.pid !== undefined && deps.isAlive(current.pid))) {
        reportMaintenanceFailure(
          target,
          deps,
          "recheck durable stopped-writer proof",
          new Error("launchd exposed a live writer before recovered rotation."),
        );
        return 1;
      }
    }

    try {
      await deps.rotateStoppedLaunchdLogs(target.paths);
      const currentPlistIdentity = await deps.verifyLaunchdPlist(target.paths.plistPath);
      if (currentPlistIdentity !== originalPlistIdentity) {
        throw new Error("The main LaunchAgent plist changed during stopped-writer maintenance.");
      }
    } catch (error) {
      reportMaintenanceFailure(target, deps, "commit bounded stopped-writer logs", error);
      return 1;
    }

    try {
      maintenanceIntent = await deps.markLaunchdLogMaintenanceRestoring(target.paths, maintenanceIntent);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "invalidate stopped-writer proof before restoration", error);
      return 1;
    }

    const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
    const observedRestorePids = new Set<number>();
    const running = await pollUntil(deps, poll, async () => {
      const current = await launchdServiceInfo(deps.runner, target.label, uid);
      if (current.pid !== undefined) observedRestorePids.add(current.pid);
      return current.loaded && current.pid !== undefined && deps.isAlive(current.pid);
    });
    if (!running) {
      const current = await launchdServiceInfo(deps.runner, target.label, uid);
      if (current.pid !== undefined) observedRestorePids.add(current.pid);
      const cleanedUp = await unloadLaunchdService(
        target.label,
        current,
        [...observedRestorePids],
        deps,
        uid,
        poll,
      );
      reportMaintenanceFailure(
        target,
        deps,
        "restore the exact main LaunchAgent after rotation",
        lifecycleFailure(booted, "launchd did not expose a live replacement worker"),
      );
      if (!cleanedUp.ok) {
        reportMaintenanceFailure(target, deps, "remove the failed replacement worker", cleanedUp.failure);
      }
      return 1;
    }
    try {
      const restoredPlistIdentity = await deps.verifyLaunchdPlist(target.paths.plistPath);
      if (restoredPlistIdentity !== originalPlistIdentity) {
        throw new Error("The main LaunchAgent plist changed while launchd restored the worker.");
      }
    } catch (error) {
      const restoredService = await launchdServiceInfo(deps.runner, target.label, uid);
      const stoppedAgain = await unloadLaunchdService(
        target.label,
        restoredService,
        uniquePids([restoredService.pid, ...observedRestorePids]),
        deps,
        uid,
        poll,
      );
      reportMaintenanceFailure(target, deps, "prove the restored main LaunchAgent definition", error);
      if (!stoppedAgain.ok) {
        reportMaintenanceFailure(target, deps, "stop the worker after its definition changed", stoppedAgain.failure);
      }
      return 1;
    }
    try {
      await deps.clearLaunchdLogMaintenanceIntent(target.paths, maintenanceIntent);
    } catch (error) {
      reportMaintenanceFailure(target, deps, "clear durable launchd-log maintenance intent", error);
      return 1;
    }
    return 0;
  } finally {
    await release().catch((error: unknown) => {
      deps.stderr(ui.errorLine(
        `Could not release lifecycle lock for ${target.label}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  }
}

export function reportMaintenanceFailure(
  target: BackgroundLifecycleTarget,
  deps: BackgroundDeps,
  action: string,
  error: unknown,
): void {
  deps.stderr(ui.errorLine(
    `Scheduled log maintenance could not ${action} for ${target.label}: ${maintenanceErrorMessage(error)}`,
  ));
}
