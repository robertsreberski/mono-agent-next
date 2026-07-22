import { describe, expect, it } from "vitest";

import * as operatorAdapter from "../index.js";
import type {
  TuiAdapterOptions,
  TuiAdapterStartResult,
} from "../index.js";

type PublicTypeSmoke = {
  readonly tuiOptions?: TuiAdapterOptions;
  readonly tuiResult?: TuiAdapterStartResult;
};

describe("operator-adapter public API", () => {
  it("exposes the documented TUI API from the root barrel", () => {
    const _typeSmoke: PublicTypeSmoke = {};

    expect(_typeSmoke).toEqual({});
    expect(operatorAdapter.startTuiAdapter).toEqual(expect.any(Function));
    expect(operatorAdapter.loadTuiAdapterConfig).toEqual(expect.any(Function));
    expect(operatorAdapter.redactTuiAdapterConfig).toEqual(expect.any(Function));
    expect(operatorAdapter.TUI_CONFIG_FIELDS.length).toBeGreaterThan(0);
    expect(operatorAdapter.DEFAULT_TUI_BASE_PATH).toBe("/gui");
    expect(operatorAdapter.DEFAULT_TUI_HOST).toBe("127.0.0.1");
    expect(operatorAdapter.DEFAULT_TUI_PORT).toBe(0);
    expect(operatorAdapter.MAX_FRAME_BYTES).toBe(256 * 1024);
    expect(operatorAdapter.TUI_WIRE_SCHEMA).toBe(1);
  });

  it("does not expose legacy generic TUI default constant names from the root", () => {
    expect("DEFAULT_BASE_PATH" in operatorAdapter).toBe(false);
    expect("DEFAULT_HOST" in operatorAdapter).toBe(false);
    expect("DEFAULT_PORT" in operatorAdapter).toBe(false);
  });
});
