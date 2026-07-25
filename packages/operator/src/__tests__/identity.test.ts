// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  OperatorIdentityBindingError,
  assertOperatorIdentity,
  type DiscoveredOperator,
  type OperatorInfo,
} from "../index.js";
import { VALID_OPERATOR_INFO } from "../testing.js";

function entry(overrides: Partial<DiscoveredOperator> = {}): DiscoveredOperator {
  return {
    id: VALID_OPERATOR_INFO.agent.id,
    label: VALID_OPERATOR_INFO.agent.label,
    endpoint: "http://127.0.0.1:4321/operator",
    pid: VALID_OPERATOR_INFO.process.pid,
    startedAt: VALID_OPERATOR_INFO.process.startedAt,
    heartbeatAt: "2026-01-02T03:04:10.000Z",
    stale: false,
    sourcePath: "/owner-private/fixture.json",
    ...overrides,
  };
}

function info(overrides: Partial<OperatorInfo> = {}): OperatorInfo {
  return { ...VALID_OPERATOR_INFO, ...overrides };
}

describe("assertOperatorIdentity", () => {
  it("accepts an exact process identity while treating labels as presentation", () => {
    expect(() => assertOperatorIdentity(entry({ label: "Registry Label" }), info({
      agent: { ...VALID_OPERATOR_INFO.agent, label: "Endpoint Label" },
    }))).not.toThrow();
  });

  it("rejects a different agent id first and exposes typed evidence", () => {
    const invoke = () => assertOperatorIdentity(entry(), info({
      agent: { ...VALID_OPERATOR_INFO.agent, id: "replacement-agent" },
      process: { pid: 999, startedAt: "2026-01-02T03:04:06.000Z" },
    }));
    expect(invoke).toThrow(OperatorIdentityBindingError);
    expect(invoke).toThrow('Operator identity mismatch for agent.id: registry has "fixture-agent", endpoint has "replacement-agent".');
    try {
      invoke();
    } catch (error) {
      expect(error).toMatchObject({
        code: "OPERATOR_IDENTITY_MISMATCH",
        field: "agent.id",
        expected: "fixture-agent",
        actual: "replacement-agent",
      });
    }
  });

  it("rejects endpoint reuse by another process id", () => {
    expect(() => assertOperatorIdentity(entry(), info({
      process: { ...VALID_OPERATOR_INFO.process, pid: 999 },
    }))).toThrow("process.pid");
  });

  it("rejects a restarted process even when the pid was reused", () => {
    expect(() => assertOperatorIdentity(entry(), info({
      process: { ...VALID_OPERATOR_INFO.process, startedAt: "2026-01-02T03:04:06.000Z" },
    }))).toThrow("process.startedAt");
  });
});
