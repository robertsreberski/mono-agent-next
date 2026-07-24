import type { DiscoveredOperator, OperatorInfo } from "./types.js";

export type OperatorIdentityBindingField = "agent.id" | "process.pid" | "process.startedAt";

export class OperatorIdentityBindingError extends Error {
  readonly code = "OPERATOR_IDENTITY_MISMATCH";
  readonly field: OperatorIdentityBindingField;
  readonly expected: string | number;
  readonly actual: string | number;

  constructor(
    field: OperatorIdentityBindingField,
    expected: string | number,
    actual: string | number,
  ) {
    super(`Operator identity mismatch for ${field}: registry has ${JSON.stringify(expected)}, endpoint has ${JSON.stringify(actual)}.`);
    this.name = "OperatorIdentityBindingError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Bind a freshly fetched `/v1/info` response to the selected owner-private
 * discovery descriptor. Labels are presentation metadata and intentionally do
 * not participate in process identity.
 */
export function assertOperatorIdentity(
  entry: DiscoveredOperator,
  info: OperatorInfo,
): void {
  if (entry.id !== info.agent.id) {
    throw new OperatorIdentityBindingError("agent.id", entry.id, info.agent.id);
  }
  if (entry.pid !== info.process.pid) {
    throw new OperatorIdentityBindingError("process.pid", entry.pid, info.process.pid);
  }
  if (entry.startedAt !== info.process.startedAt) {
    throw new OperatorIdentityBindingError("process.startedAt", entry.startedAt, info.process.startedAt);
  }
}
