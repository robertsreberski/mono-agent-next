import type { RuntimeNativeToolDescriptor } from "@mono-agent/module-sdk";

export const runtimePiBashTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "Bash",
  displayName: "Bash",
  effects: Object.freeze(["read", "write", "execute", "network"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiReadTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "Read",
  displayName: "Read",
  effects: Object.freeze(["read"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiWriteTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "Write",
  displayName: "Write",
  effects: Object.freeze(["write"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiGlobTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "Glob",
  displayName: "Glob",
  effects: Object.freeze(["read"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiGrepTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "Grep",
  displayName: "Grep",
  // Pi's public Grep implementation executes ripgrep and can install it if it
  // is absent. Advertise the complete possible authority rather than the
  // common already-installed case.
  effects: Object.freeze(["read", "write", "execute", "network"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiWebFetchTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "WebFetch",
  displayName: "Web Fetch",
  effects: Object.freeze(["network"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiCodingNativeTools: readonly RuntimeNativeToolDescriptor[] =
  Object.freeze([
    runtimePiReadTool,
    runtimePiWriteTool,
    runtimePiGlobTool,
    runtimePiGrepTool,
    runtimePiBashTool,
    runtimePiWebFetchTool,
  ]);
