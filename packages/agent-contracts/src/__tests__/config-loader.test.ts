import { describe, expect, it } from "vitest";

import {
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readCsv,
  readInteger,
  readJsonSection,
  readRecord,
  readRequired,
  readString,
  redactedSecret,
} from "../index.js";
import type { ConfigErrorFactory } from "../index.js";

class TestConfigError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TestConfigError";
    this.details = details;
  }
}

const onInvalid: ConfigErrorFactory = (message, details) =>
  new TestConfigError(message, details ?? {});

describe("normalizeOptionalString", () => {
  it("trims and treats blank as absent", () => {
    expect(normalizeOptionalString("  x  ")).toBe("x");
    expect(normalizeOptionalString("   ")).toBeUndefined();
    expect(normalizeOptionalString(undefined)).toBeUndefined();
  });
});

describe("readString / readRequired", () => {
  it("falls back to the default when unset", () => {
    expect(readString(undefined, "d")).toBe("d");
    expect(readString("  v ", "d")).toBe("v");
  });

  it("readRequired throws the caller's typed error with a named message when absent", () => {
    expect(() => readRequired(" ", "MONO_X", onInvalid)).toThrow("MONO_X is required.");
    expect(readRequired(" v ", "MONO_X", onInvalid)).toBe("v");
  });
});

describe("readCsv", () => {
  it("splits, trims, and drops empties", () => {
    expect(readCsv(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(readCsv(undefined)).toEqual([]);
  });
});

describe("readBoolean", () => {
  it("coerces true/false and defaults", () => {
    expect(readBoolean("true", "X", false, onInvalid)).toBe(true);
    expect(readBoolean("false", "X", true, onInvalid)).toBe(false);
    expect(readBoolean(undefined, "X", true, onInvalid)).toBe(true);
  });

  it("throws on non-boolean input", () => {
    expect(() => readBoolean("yes", "X", false, onInvalid)).toThrow(
      "X must be true or false.",
    );
  });
});

describe("readInteger", () => {
  it("coerces integers and applies bounds", () => {
    expect(readInteger("7", "X", 0, onInvalid)).toBe(7);
    expect(readInteger(undefined, "X", 3, onInvalid)).toBe(3);
    expect(readInteger("5", "X", 0, onInvalid, { min: 0, max: 10 })).toBe(5);
  });

  it("rejects non-integers and out-of-bounds", () => {
    expect(() => readInteger("1.5", "X", 0, onInvalid)).toThrow(
      "X must be an integer.",
    );
    expect(() => readInteger("99", "X", 0, onInvalid, { min: 0, max: 10 })).toThrow(
      "X must be between 0 and 10.",
    );
  });
});

describe("readChoice", () => {
  it("accepts members, defaults when absent, rejects others", () => {
    const choices = ["a", "b"] as const;
    expect(readChoice("b", "X", choices, "a", onInvalid)).toBe("b");
    expect(readChoice(undefined, "X", choices, "a", onInvalid)).toBe("a");
    expect(() => readChoice("c", "X", choices, "a", onInvalid)).toThrow(
      "X must be one of: a, b.",
    );
  });
});

describe("readRecord / readJsonSection", () => {
  it("narrows objects only", () => {
    expect(readRecord({ a: 1 })).toEqual({ a: 1 });
    expect(readRecord(null)).toEqual({});
    expect(readRecord([1, 2])).toEqual({});
    expect(readJsonSection({ x: { a: 1 } }, "x")).toEqual({ a: 1 });
    expect(readJsonSection({}, "x")).toEqual({});
  });
});

describe("layerJsonOntoEnv", () => {
  it("encodes JSON defaults then lets real env win", () => {
    const layered = layerJsonOntoEnv(
      { MONO_X_PORT: "9", MONO_X_UNSET: undefined },
      [
        { env: "MONO_X_ENABLED", value: true, kind: "boolean" },
        { env: "MONO_X_PORT", value: 3, kind: "integer" },
        { env: "MONO_X_NAME", value: "from-json", kind: "string" },
        { env: "MONO_X_TAGS", value: ["a", "b"], kind: "csv" },
        { env: "MONO_X_SKIP", value: 1.5, kind: "integer" },
      ],
    );
    expect(layered.MONO_X_ENABLED).toBe("true");
    expect(layered.MONO_X_PORT).toBe("9"); // env wins over JSON default of 3
    expect(layered.MONO_X_NAME).toBe("from-json");
    expect(layered.MONO_X_TAGS).toBe("a,b");
    expect(layered.MONO_X_SKIP).toBeUndefined(); // non-integer not encoded
  });
});

describe("redactedSecret", () => {
  it("marks presence without exposing the value", () => {
    expect(redactedSecret("token")).toEqual({ present: true, redacted: true });
    expect(redactedSecret("")).toEqual({ present: false, redacted: true });
    expect(redactedSecret(undefined)).toEqual({ present: false, redacted: true });
  });
});
