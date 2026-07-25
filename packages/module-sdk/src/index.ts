/**
 * Public, Apache-2.0 extension contracts for mono-agent modules.
 *
 * This entrypoint deliberately exposes only the three open module slots:
 * runtime, channel, and memory. First-party reserved slots live at
 * `@mono-agent/module-sdk/internal` until they are promoted through the public
 * architecture process.
 */
export * from "./config.js";
export * from "./interactions.js";
export * from "./modules.js";
export * from "./http.js";
export * from "./secure-fs.js";
