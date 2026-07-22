import { describe, expect, it, vi } from "vitest";

import { validateCronExpression } from "../cron-expression.js";

describe("validateCronExpression", () => {
  it("returns the next UTC occurrence deterministically", () => {
    const result = validateCronExpression("15 9 * * MON-FRI", {
      currentDate: new Date("2026-07-10T08:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      nextDate: new Date("2026-07-10T09:15:00.000Z"),
    });
  });

  it("trims surrounding whitespace", () => {
    const result = validateCronExpression("  \t0 8 * * *\n", {
      currentDate: new Date("2026-07-10T07:30:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      nextDate: new Date("2026-07-10T08:00:00.000Z"),
    });
  });

  it("supports ranges, steps, and named months and weekdays", () => {
    const result = validateCronExpression("*/15 9-10 * JAN,MAR MON-FRI", {
      currentDate: new Date("2026-01-05T08:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      nextDate: new Date("2026-01-05T09:00:00.000Z"),
    });
  });

  it("requires a stable seed for hashed fields without mistaking THU for H", () => {
    expect(validateCronExpression("H * * * *", {
      currentDate: new Date("2026-07-10T07:30:00.000Z"),
    })).toEqual({
      ok: false,
      code: "invalid",
      reason: 'Hashed "H" cron fields require a non-empty hashSeed.',
    });
    expect(validateCronExpression("0 8 * * THU", {
      currentDate: new Date("2026-07-10T07:30:00.000Z"),
    })).toEqual({
      ok: true,
      nextDate: new Date("2026-07-16T08:00:00.000Z"),
    });
  });

  it("keeps hashed fields deterministic for repeated parses with the same seed", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const options = {
        currentDate: new Date("2026-07-10T07:30:00.000Z"),
        hashSeed: "daily-check",
      } as const;

      const first = validateCronExpression("H * * * *", options);
      const second = validateCronExpression("H * * * *", options);

      expect(first).toEqual(second);
      expect(first).toMatchObject({ ok: true, nextDate: expect.any(Date) });
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it.each([
    {
      label: "summer offset in a non-local timezone",
      expression: "0 9 * * *",
      currentDate: "2026-07-10T06:30:00.000Z",
      timezone: "Europe/Amsterdam",
      nextDate: "2026-07-10T07:00:00.000Z",
    },
    {
      label: "spring-forward gap",
      expression: "30 2 * * *",
      currentDate: "2026-03-28T23:00:00.000Z",
      timezone: "Europe/Amsterdam",
      nextDate: "2026-03-29T01:30:00.000Z",
    },
    {
      label: "fall-back overlap",
      expression: "30 2 * * *",
      currentDate: "2026-10-24T22:00:00.000Z",
      timezone: "Europe/Amsterdam",
      nextDate: "2026-10-25T00:30:00.000Z",
    },
  ])("honors configured timezone semantics across $label", ({
    expression,
    currentDate,
    timezone,
    nextDate,
  }) => {
    expect(validateCronExpression(expression, {
      currentDate: new Date(currentDate),
      timezone,
    })).toEqual({
      ok: true,
      nextDate: new Date(nextDate),
    });
  });

  it.each([
    [undefined],
    [""],
    [" \t\n "],
  ])("requires a non-empty expression (%s)", (expression) => {
    expect(validateCronExpression(expression)).toEqual({ ok: false, code: "required" });
  });

  it.each([
    ["0 8 * *", 4],
    ["0 0 8 * * *", 6],
    ["@daily", 1],
  ])("rejects non-five-field syntax (%s)", (expression, fieldCount) => {
    expect(validateCronExpression(expression)).toEqual({
      ok: false,
      code: "field_count",
      fieldCount,
    });
  });

  it.each([
    ["61 * * * *", /range 0-59/u],
    ["0 0 31 2 *", /day of month/u],
  ])("returns the parser reason for invalid schedules (%s)", (expression, reason) => {
    expect(validateCronExpression(expression)).toEqual({
      ok: false,
      code: "invalid",
      reason: expect.stringMatching(reason),
    });
  });

  it("returns an invalid result for an unknown timezone", () => {
    expect(validateCronExpression("0 8 * * *", {
      currentDate: new Date("2026-07-10T07:30:00.000Z"),
      timezone: "Not/A_Timezone",
    })).toEqual({
      ok: false,
      code: "invalid",
      reason: expect.any(String),
    });
  });
});
