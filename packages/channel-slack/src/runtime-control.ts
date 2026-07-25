// SPDX-License-Identifier: MIT
const MAX_RUNTIME_SELECTIONS = 1_000;

export interface SlackRuntimeSelection {
  readonly model?: string;
  readonly effort?: string;
}

export interface SlackRuntimeCommand {
  readonly field: "model" | "effort";
  readonly value?: string;
}

export function runtimeCommand(text: string): SlackRuntimeCommand | undefined {
  const match = /^(?:<@[A-Z0-9]+>\s+)?\/(model|effort)(?:\s+(\S+))?\s*$/u.exec(
    text.trim(),
  );
  if (match === null) return undefined;
  const value = match[2];
  if (value !== undefined
    && (value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value))) {
    return undefined;
  }
  return {
    field: match[1] as "model" | "effort",
    ...(value === undefined ? {} : { value }),
  };
}

export function updateRuntimeSelection(
  current: SlackRuntimeSelection | undefined,
  command: SlackRuntimeCommand,
): SlackRuntimeSelection {
  if (command.value === undefined) return Object.freeze({ ...(current ?? {}) });
  const next = { ...(current ?? {}) };
  if (command.value === "default") {
    delete next[command.field];
    if (command.field === "model") delete next.effort;
  } else {
    next[command.field] = command.value;
    if (command.field === "model") delete next.effort;
  }
  return Object.freeze(next);
}

export function rememberRuntimeSelection(
  selections: Map<string, SlackRuntimeSelection>,
  conversationId: string,
  selection: SlackRuntimeSelection,
): void {
  selections.delete(conversationId);
  if (Object.keys(selection).length > 0) selections.set(conversationId, selection);
  while (selections.size > MAX_RUNTIME_SELECTIONS) {
    const oldest = selections.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    selections.delete(oldest);
  }
}

export function runtimeConfirmation(
  command: SlackRuntimeCommand,
  selection: SlackRuntimeSelection,
): string {
  if (command.value === undefined) {
    return `${command.field}: ${selection[command.field] ?? "default"}`;
  }
  const suffix = command.field === "model" ? " (effort reset)" : "";
  return `${command.field} set to ${selection[command.field] ?? "default"}.${suffix}`;
}
