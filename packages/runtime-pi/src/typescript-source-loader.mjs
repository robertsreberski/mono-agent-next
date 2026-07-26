// SPDX-License-Identifier: MIT
/**
 * Source-checkout worker loader. Published dist workers use ordinary `.js`
 * imports and never activate this hook.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code !== "ERR_MODULE_NOT_FOUND"
      || !specifier.startsWith(".")
      || !specifier.endsWith(".js")
      || !context.parentURL?.endsWith(".ts")
    ) {
      throw error;
    }
    return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
}
