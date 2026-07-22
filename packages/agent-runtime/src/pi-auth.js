// @ts-check

import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";

/**
 * @typedef {{type: "api_key", key?: string, env?: Object<string, *>}} PiApiKeyCredential
 * @typedef {{type: "oauth", access?: string, refresh?: string, expires: number, [key: string]: *}} PiOAuthCredential
 * @typedef {PiApiKeyCredential|PiOAuthCredential} PiCredential
 * @typedef {((provider: string) => Promise<string|undefined>) & {
 *   readCredential?: (provider: string) => Promise<PiCredential|undefined>,
 *   modifyCredential?: (provider: string, fn: (current: PiCredential|undefined) => Promise<PiCredential|undefined>) => Promise<PiCredential|undefined>,
 *   deleteCredential?: (provider: string) => Promise<void>
 * }} PiApiKeyResolver
 */

const authFileChains = new Map();

/**
 * @param {Object} [options]
 * @param {string} [options.path] Path to the pi auth.json credentials file.
 * @returns {PiApiKeyResolver}
 */
export function createPiOAuthApiKeyResolver(options = {}) {
  const configuredAuthPath = typeof options.path === "string" && options.path.trim().length > 0
    ? options.path
    : undefined;
  const authPath = configuredAuthPath ? canonicalizeAuthPath(configuredAuthPath) : undefined;

  async function resolvePiOAuthApiKey(provider) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return undefined;
    }

    return enqueueAuthFile(authPath, async () => {
      const auth = await readAuthFile(authPath);
      if (auth === undefined || auth[provider] === undefined) {
        return undefined;
      }

      const result = await getOAuthApiKey(provider, cloneAuth(auth));
      if (result === null || result === undefined || typeof result.apiKey !== "string" || result.apiKey.length === 0) {
        return undefined;
      }

      auth[provider] = {
        type: "oauth",
        ...result.newCredentials,
      };
      await writeAuthFile(authPath, auth);
      return result.apiKey;
    });
  }

  resolvePiOAuthApiKey.readCredential = async function readCredential(provider) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return undefined;
    }
    const auth = await readAuthFile(authPath);
    return cloneCredential(auth?.[provider]);
  };

  resolvePiOAuthApiKey.modifyCredential = async function modifyCredential(provider, fn) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return undefined;
    }
    if (typeof fn !== "function") {
      throw new TypeError("modifyCredential requires a function");
    }
    return enqueueAuthFile(authPath, async () => {
      const auth = (await readAuthFile(authPath)) || {};
      const current = cloneCredential(auth[provider]);
      const next = await fn(current);
      if (next !== undefined) {
        auth[provider] = cloneCredential(next) || next;
        await writeAuthFile(authPath, auth);
        return cloneCredential(auth[provider]);
      }
      return current;
    });
  };

  resolvePiOAuthApiKey.deleteCredential = async function deleteCredential(provider) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return;
    }
    await enqueueAuthFile(authPath, async () => {
      const auth = await readAuthFile(authPath);
      if (!auth || !Object.hasOwn(auth, provider)) return;
      delete auth[provider];
      await writeAuthFile(authPath, auth);
    });
  };

  return resolvePiOAuthApiKey;
}

/**
 * @param {string} path
 * @param {() => Promise<*>} task
 * @returns {Promise<*>}
 */
function enqueueAuthFile(path, task) {
  const previous = authFileChains.get(path) ?? Promise.resolve();
  const next = (async () => {
    await previous.catch(() => {});
    return task();
  })();
  authFileChains.set(path, next.catch(() => {}));
  return next;
}

/**
 * @param {string} path
 * @returns {string}
 */
function canonicalizeAuthPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if (!isMissingPathError(error)) {
      return resolved;
    }
  }

  try {
    return join(realpathSync.native(dirname(resolved)), basename(resolved));
  } catch {
    return resolved;
  }
}

/**
 * @param {*} error
 * @returns {boolean}
 */
function isMissingPathError(error) {
  return error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * @param {Object<string, *>} auth
 * @returns {Object<string, *>}
 */
function cloneAuth(auth) {
  return Object.fromEntries(
    Object.entries(auth).map(([provider, credentials]) => [
      provider,
      cloneCredential(credentials),
    ]),
  );
}

/**
 * @param {*} credential
 * @returns {*}
 */
function cloneCredential(credential) {
  return credential && typeof credential === "object" && !Array.isArray(credential)
    ? { ...credential }
    : credential;
}

/**
 * @param {string} path
 * @returns {Promise<Object<string, *>|undefined>}
 */
async function readAuthFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new Error(`Unable to parse Pi auth file at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Unable to parse Pi auth file at ${path}: expected a JSON object`);
}

// The temp name carries a per-process sequence (not a timestamp) so concurrent
// writers in the same millisecond never collide on the temp path.
let atomicWriteSequence = 0;

/**
 * @param {string} path
 * @param {Object<string, *>} auth
 * @returns {Promise<void>}
 */
async function writeAuthFile(path, auth) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  atomicWriteSequence += 1;
  const tmpPath = `${path}.tmp-${process.pid}-${atomicWriteSequence}`;
  await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600);
}
