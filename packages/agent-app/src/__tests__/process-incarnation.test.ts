import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  currentProcessIncarnation,
  isSameProcessIncarnation,
  processIncarnationFromJson,
  readProcessIncarnation,
} from "../process-incarnation.js";

describe("process incarnation", () => {
  it("identifies the current PID by boot session and process birth", async () => {
    const current = await currentProcessIncarnation();

    expect(current).toMatchObject({
      schema: "mono-agent.process-incarnation.v1",
      bootSessionId: expect.any(String),
      processStartId: expect.any(String),
    });
    await expect(readProcessIncarnation(process.pid)).resolves.toEqual(current);
    await expect(isSameProcessIncarnation(process.pid, current)).resolves.toBe(true);
    await expect(isSameProcessIncarnation(process.pid, {
      ...current,
      processStartId: `${current.processStartId}-reused`,
    })).resolves.toBe(false);
  });

  it("parses only complete persisted incarnation records", () => {
    const valid = {
      schema: "mono-agent.process-incarnation.v1",
      bootSessionId: "boot-a",
      processStartId: "start-a",
    };
    expect(processIncarnationFromJson(valid)).toEqual(valid);
    expect(processIncarnationFromJson({ ...valid, bootSessionId: "" })).toBeUndefined();
    expect(processIncarnationFromJson({ ...valid, schema: "unknown" })).toBeUndefined();
    expect(processIncarnationFromJson(null)).toBeUndefined();
  });
});
