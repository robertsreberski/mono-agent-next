// Test-only RuntimeSandbox fixture + policy factory.
//
// agent-runtime's kernel has ZERO workspace-package imports (see
// ../../agent/sandbox-seam.js and its passthroughSandbox default); production
// hosts inject @mono-agent/runtime-adapter's implementation from
// packages/runtime-adapter/src/sandbox.ts (via sandbox-impl.ts).
// This fixture reimplements just enough of runtime-adapter's pure policy algebra
// (monotonic merge, engine-delegated command prep, network-mode allow checks)
// for agent-runtime's OWN tool-enforcement tests (tools.test.js,
// pi-bridge.test.js, tool-context.test.js) to exercise realistic sandbox
// behavior without a workspace dependency. It intentionally omits the real
// SRT engine integration — every test that needs `prepareCommand` to do real
// work supplies its own fake `sandboxEngine`, exactly as it did before this
// seam existed.
//
// This is a fixture, not a product path: the byte-identical real
// implementation is wired in by runtime-adapter.

const DEFAULT_DENY_WRITE = [".env", ".env.*", ".git/config", ".git/hooks/**"];

/**
 * Builds a native-mode, fail-closed policy object shaped like runtime-adapter's
 * `failClosedSandboxPolicy({...})` output — enough for
 * path-resolver.js (which reads `root`/`readableRoots`/`writableRoots`/
 * `denyWrite` directly off whatever the injected `mergePolicies` returns) to
 * enforce realistic root/write restrictions in tests.
 */
export function testSandboxPolicy({
  root,
  readableRoots,
  writableRoots,
  denyWrite = DEFAULT_DENY_WRITE,
  network = { mode: "none", allowlist: [] },
} = {}) {
  return {
    mode: "native",
    engine: "srt",
    root,
    readableRoots: readableRoots ?? [root],
    writableRoots: writableRoots ?? [root],
    denyWrite,
    tempRoot: `${root}/.mono-agent/tmp`,
    network,
    fallback: "fail-closed",
    unsafeAllowHostProcess: false,
  };
}

function pathContains(root, target) {
  return target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
}

function removeCoveredRoots(paths) {
  const out = [];
  for (const path of paths) {
    if (out.some((existing) => pathContains(existing, path))) continue;
    out.push(path);
  }
  return out;
}

function intersectRoots(configured, request) {
  const out = new Set();
  for (const configuredRoot of configured || []) {
    for (const requestRoot of request || []) {
      if (pathContains(configuredRoot, requestRoot)) out.add(requestRoot);
      else if (pathContains(requestRoot, configuredRoot)) out.add(configuredRoot);
    }
  }
  return removeCoveredRoots([...out].sort());
}

function isLocalhost(host) {
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || String(host).startsWith("127.");
}

function mergeNetwork(configured, request) {
  if (!request) return configured;
  if (!configured) return request;
  if (configured.mode === "none" || request.mode === "none") return { mode: "none", allowlist: [] };
  if (configured.mode === "all") return { mode: request.mode, allowlist: [...(request.allowlist || [])] };
  if (request.mode === "all") return { mode: configured.mode, allowlist: [...(configured.allowlist || [])] };
  if (configured.mode === "localhost" && request.mode === "localhost") return { mode: "localhost", allowlist: [] };
  if (configured.mode === "allowlist" && request.mode === "allowlist") {
    const requestDomains = new Set(request.allowlist || []);
    const allowlist = (configured.allowlist || []).filter((domain) => requestDomains.has(domain)).sort();
    return allowlist.length === 0 ? { mode: "none", allowlist: [] } : { mode: "allowlist", allowlist };
  }
  const loopback = ((configured.mode === "allowlist" ? configured.allowlist : request.allowlist) || [])
    .filter(isLocalhost)
    .sort();
  return loopback.length === 0 ? { mode: "none", allowlist: [] } : { mode: "allowlist", allowlist: loopback };
}

function mergePolicies(configured, request) {
  if (configured === undefined) return request;
  if (request === undefined) return configured;
  if (configured.mode === "off") return request.mode === "native" ? request : configured;
  if (request.mode === "off") return configured;
  return {
    ...configured,
    readableRoots: intersectRoots(configured.readableRoots, request.readableRoots),
    writableRoots: intersectRoots(configured.writableRoots, request.writableRoots),
    denyWrite: [...new Set([...(configured.denyWrite ?? []), ...(request.denyWrite ?? [])])],
    network: mergeNetwork(configured.network, request.network),
    fallback: configured.fallback === "fail-closed" || request.fallback === "fail-closed" ? "fail-closed" : configured.fallback,
    unsafeAllowHostProcess: configured.unsafeAllowHostProcess && request.unsafeAllowHostProcess,
  };
}

async function prepareCommand({ policy, engine, command }) {
  if (policy == null || policy.mode === "off") {
    return { ...command, args: command.args ?? [], cwd: command.cwd ?? process.cwd(), sandboxed: false };
  }
  if (engine && (await engine.isAvailable())) {
    return engine.prepareCommand(command, policy);
  }
  if (policy.fallback === "unsafe-host-process" && policy.unsafeAllowHostProcess) {
    return { ...command, args: command.args ?? [], cwd: command.cwd ?? process.cwd(), sandboxed: false };
  }
  const error = new Error("Sandbox engine is unavailable and policy is fail-closed.");
  error.name = "SandboxUnavailableError";
  error.code = "sandbox_unavailable";
  error.details = { code: "sandbox_unavailable" };
  throw error;
}

function domainMatches(host, pattern) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function networkAllowsUrl(policy, url) {
  if (policy == null || policy.mode === "off") return true;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const net = policy.network || { mode: "none", allowlist: [] };
  if (net.mode === "all") return true;
  if (net.mode === "none") return false;
  if (net.mode === "localhost") return isLocalhost(host);
  return (net.allowlist || []).some((domain) => domainMatches(host, domain));
}

/** Builds a fresh RuntimeSandbox fixture (see module doc). */
export function createFakeSandbox() {
  return { mergePolicies, prepareCommand, networkAllowsUrl };
}
