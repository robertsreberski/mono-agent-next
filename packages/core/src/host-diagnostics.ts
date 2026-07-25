// SPDX-License-Identifier: MIT
import type { ModuleDiagnostic, ModuleInstance } from "@mono-agent/module-sdk";
import type { StateStore } from "@mono-agent/module-sdk/internal";
import { denseOwnDataArray as boundedOwnDataArray } from "./bounded-value.js";
import { AgentModuleError, errorMessage } from "./errors.js";
import { normalizeModuleHealth, normalizeModuleJson } from "./host-health.js";
import type { HostLifecycleCalls } from "./host-lifecycle.js";
import { NULL_LOGGER } from "./host-module-instances.js";
import { boundedUtf8, inspectModuleFailure, sanitizeModuleCommandError } from "./host-redaction.js";
import type { RunningModule } from "./host-types.js";
import { normalizeModuleDiagnostic } from "./runtime-result-normalizer.js";
import { StateExecutionClient } from "./state-execution-client.js";
import type {
  AgentModuleCommandResult, AgentModuleDiagnostics, LoadedAgentConfig, LoadedAgentModule,
} from "./types.js";

const MODULE_DIAGNOSTIC_MAX_ITEMS = 100;

interface DiagnosticsContext {
  readonly config: LoadedAgentConfig;
  readonly lifecycle: HostLifecycleCalls;
  running(): readonly RunningModule[];
  createInstance(module: LoadedAgentModule, signal: AbortSignal): Promise<ModuleInstance>;
  redact(message: string): string;
}

/**
 * Owns module command invocation and module diagnostics, including the
 * create/run/stop failure attribution that keeps a module fault distinguishable
 * from a host fault.
 */
export class HostDiagnostics {
  constructor(private readonly context: DiagnosticsContext) {}

  async runCommand(
    moduleInstanceId: string, commandName: string, input?: unknown,
  ): Promise<AgentModuleCommandResult> {
    const running = this.context.running().find((candidate) => candidate.loaded.instanceId === moduleInstanceId);
    if (running !== undefined) {
      try { return await this.#invoke(running.loaded, running.instance, commandName, input); }
      catch (error) { throw this.#commandError(error, running.loaded, commandName, "run"); }
    }
    const loaded = this.context.config.modules.find((candidate) => candidate.instanceId === moduleInstanceId);
    if (loaded === undefined) throw new Error(`Module ${moduleInstanceId} is not selected`);
    let instance: ModuleInstance | undefined;
    try {
      instance = await this.context.lifecycle.run(
        `${loaded.instanceId} command create`,
        (signal) => this.context.createInstance(loaded, signal),
      );
      if (instance === undefined) throw new Error(`${loaded.instanceId} command create returned undefined`);
    } catch (error) { throw this.#commandError(error, loaded, commandName, "create"); }
    let result: AgentModuleCommandResult | undefined;
    let runFailure: unknown; let runFailed = false;
    try { result = await this.#invoke(loaded, instance, commandName, input); }
    catch (error) { runFailure = error; runFailed = true; }
    let stopFailure: unknown; let stopFailed = false;
    if (instance.stop !== undefined) {
      try {
        await this.context.lifecycle.cleanup(
          `${loaded.instanceId} command stop`,
          (signal) => instance.stop?.({ signal, reason: "shutdown" }),
        );
      } catch (error) { stopFailure = error; stopFailed = true; }
    }
    if (runFailed && stopFailed) {
      throw this.#commandError(
        new AggregateError(
          [runFailure, stopFailure],
          `Command failed: ${inspectModuleFailure(runFailure)}; cleanup failed: ${inspectModuleFailure(stopFailure)}`,
        ),
        loaded, commandName, "run_and_stop",
      );
    }
    if (runFailed) throw this.#commandError(runFailure, loaded, commandName, "run");
    if (stopFailed) throw this.#commandError(stopFailure, loaded, commandName, "stop");
    return result!;
  }

  async inspect(verbose = false): Promise<readonly AgentModuleDiagnostics[]> {
    if (typeof verbose !== "boolean") throw new TypeError("diagnostics verbose must be boolean");
    const running = this.context.running();
    if (running.length > 0) {
      return Promise.all(running.map(({ loaded, instance }) => this.#diagnose(loaded, instance, verbose)));
    }
    const results: AgentModuleDiagnostics[] = [];
    for (const loaded of [...this.context.config.modules]
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId))) {
      let instance: ModuleInstance;
      try {
        const created = await this.context.lifecycle.run(
          `${loaded.instanceId} diagnostics create`,
          (signal) => this.context.createInstance(loaded, signal),
        );
        if (created === undefined) throw new Error(`${loaded.instanceId} diagnostics create returned undefined`);
        instance = created;
      } catch (error) {
        results.push(this.#failure(loaded, "module_diagnostics_create_failed", error));
        continue;
      }
      let result = await this.#diagnose(loaded, instance, verbose);
      if (instance.stop !== undefined) {
        try {
          await this.context.lifecycle.cleanup(
            `${loaded.instanceId} diagnostics stop`,
            (signal) => instance.stop?.({ signal, reason: "shutdown" }),
          );
        } catch (error) {
          result = {
            ...result,
            diagnostics: [...result.diagnostics, this.#diagnostic("module_diagnostics_stop_failed", error)],
          };
        }
      }
      results.push(result);
    }
    return Object.freeze(results);
  }

  async #invoke(
    loaded: LoadedAgentModule, instance: ModuleInstance, commandName: string, input?: unknown,
  ): Promise<AgentModuleCommandResult> {
    const command = instance.commands?.find((candidate) => candidate.name === commandName);
    if (command === undefined) throw new Error(`Module ${loaded.instanceId} does not expose command ${commandName}`);
    const value = await this.context.lifecycle.run(
      `${loaded.instanceId} command ${commandName}`,
      (signal) => command.run(input, { signal, logger: NULL_LOGGER }),
    );
    return {
      module: loaded.instanceId,
      command: commandName,
      ...(value === undefined
        ? {}
        : { value: normalizeModuleJson(value, "module command result", (text) => this.context.redact(text)) }),
    };
  }

  async #diagnose(
    loaded: LoadedAgentModule, instance: ModuleInstance, verbose: boolean,
  ): Promise<AgentModuleDiagnostics> {
    if (loaded.slot === "state") {
      try {
        const execution = (instance as StateStore).execution;
        if (execution === undefined) throw new Error(`${loaded.instanceId} does not expose the required state execution capability`);
        await this.context.lifecycle.run(
          `${loaded.instanceId} state execution protocol`,
          (signal) => new StateExecutionClient(execution).assertCompatible(signal),
        );
      } catch (error) {
        return this.#failure(loaded, "state_execution_protocol_incompatible", error);
      }
    }
    if (instance.diagnostics === undefined) {
      if (instance.health !== undefined && ["memory", "state", "sandbox", "exporter"].includes(loaded.slot)) {
        try {
          const raw = await this.context.lifecycle.run(
            `${loaded.instanceId} diagnostic health`,
            (signal) => instance.health?.({ signal }),
          );
          const health = normalizeModuleHealth(
            raw,
            `${loaded.instanceId} diagnostic health`,
            (text) => this.context.redact(text),
          );
          if (health.status !== "healthy") {
            return this.#result(loaded, [Object.freeze({
                code: `module_health_${health.status}`,
                severity: health.status === "unhealthy" ? "error" : "warning",
                message: health.summary ?? `Module health is ${health.status}`,
            })]);
          }
        } catch (error) {
          return this.#failure(loaded, "module_diagnostic_health_failed", error);
        }
      }
      return this.#result(loaded, []);
    }
    try {
      const raw = await this.context.lifecycle.run(
        `${loaded.instanceId} diagnostics`,
        (signal) => instance.diagnostics?.({ signal, verbose }),
      );
      const values = boundedOwnDataArray(
        raw,
        `${loaded.instanceId} diagnostics`,
        MODULE_DIAGNOSTIC_MAX_ITEMS,
        true,
        true,
      );
      const diagnostics = values.map((value, index) => {
        const diagnostic = normalizeModuleDiagnostic(
          value,
          `${loaded.instanceId} diagnostics[${String(index)}]`,
        );
        return Object.freeze({
          ...diagnostic,
          message: this.context.redact(diagnostic.message),
          ...(diagnostic.hint === undefined ? {} : { hint: this.context.redact(diagnostic.hint) }),
        });
      });
      return this.#result(loaded, diagnostics);
    } catch (error) {
      return this.#failure(loaded, "module_diagnostics_failed", error);
    }
  }

  #failure(loaded: LoadedAgentModule, code: string, error: unknown): AgentModuleDiagnostics {
    return this.#result(loaded, [this.#diagnostic(code, error)]);
  }

  #result(loaded: LoadedAgentModule, diagnostics: readonly ModuleDiagnostic[]): AgentModuleDiagnostics {
    return Object.freeze({
      kind: loaded.slot, instanceId: loaded.instanceId,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  #diagnostic(code: string, error: unknown): ModuleDiagnostic {
    return Object.freeze({
      code,
      severity: "error",
      message: boundedUtf8(this.context.redact(errorMessage(error)), 4_096),
    });
  }

  #commandError(
    error: unknown, loaded: LoadedAgentModule, commandName: string,
    phase: "create" | "run" | "stop" | "run_and_stop",
  ): AgentModuleError {
    const redact = (value: string): string => this.context.redact(value);
    const cause = sanitizeModuleCommandError(error, redact);
    const code = `module_command_${phase}_failed`;
    return new AgentModuleError(boundedUtf8(
      redact(`${code}: ${loaded.instanceId} command ${commandName} ${phase.replaceAll("_", " ")} failed: ${cause.message}`),
      4_096,
    ), {
      code,
      packageName: redact(loaded.packageName), configPath: redact(loaded.configPath),
      moduleInstanceId: redact(loaded.instanceId), commandName: boundedUtf8(redact(commandName), 512), phase, cause,
    });
  }
}
