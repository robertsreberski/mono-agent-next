#!/usr/bin/env node
/**
 * Embed launcher for SRT's unrestricted-network mode.
 *
 * The pinned SRT CLI requires a `network` block in its settings schema and
 * always starts domain filtering when one is present, so "filesystem
 * enforcement with open networking" is only reachable through the library
 * API: initializing with an empty network object keeps every filesystem rule
 * while SRT skips its proxy and domain filter entirely (its restriction
 * trigger is a defined `network.allowedDomains`). This runner is spawned with
 * the same verified Node executable as the CLI launch and imports the library
 * entry from the identity-checked SRT tree it is given.
 *
 * Invocation: srt-embed-runner.mjs <srt-index.js> --settings <settings.json> -- <command> [args...]
 *
 * The spawn/exit contract mirrors the SRT CLI: the wrapped command string is
 * run through the shell, SIGINT/SIGTERM forward to the child, bwrap mount
 * artifacts are cleaned up after the command, and the child's exit code is
 * this process's exit code.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function fail(message, code = 78) {
  console.error(`srt-embed-runner: ${message}`);
  process.exit(code);
}

if (process.platform === "win32") {
  fail("the embed launch supports POSIX platforms only");
}

const argv = process.argv.slice(2);
const entryPath = argv[0];
if (entryPath === undefined || argv[1] !== "--settings" || argv[2] === undefined || argv[3] !== "--") {
  fail("usage: srt-embed-runner <srt-index.js> --settings <settings.json> -- <command> [args...]");
}
const settingsPath = argv[2];
const command = argv.slice(4);
if (command.length === 0) {
  fail("no command specified");
}

let settings;
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch (error) {
  fail(`settings file is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (settings === null || typeof settings !== "object" || typeof settings.filesystem !== "object" || settings.filesystem === null) {
  fail("settings must carry a filesystem policy");
}
if (settings.network !== undefined) {
  fail("settings with a network block belong to the SRT CLI launch; refusing to run them without domain filtering");
}

let SandboxManager;
try {
  ({ SandboxManager } = await import(pathToFileURL(entryPath).href));
} catch (error) {
  fail(`SRT library entry could not be imported: ${error instanceof Error ? error.message : String(error)}`);
}
if (SandboxManager === undefined) {
  fail("SRT library entry does not export SandboxManager");
}

try {
  await SandboxManager.initialize({ network: {}, filesystem: settings.filesystem });
} catch (error) {
  fail(`SRT initialization failed: ${error instanceof Error ? error.message : String(error)}`);
}

// argv entries may contain any bytes; single-quote each one so the shell
// re-parse inside SRT's `bash -c` wrapper preserves them verbatim.
const quoted = command.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
let wrapped = await SandboxManager.wrapWithSandbox(quoted);

// macOS system DNS is a local service, not plain sockets: getaddrinfo talks
// to mDNSResponder over an AF_UNIX socket reached through the /var symlink,
// and resolver-config readers open /etc/resolv.conf through the /etc and
// /var symlinks. The unrestricted-network profile allows `network*` but none
// of that, so name resolution fails with ENOTFOUND while raw IP egress
// works. Reopen exactly those paths — the resolv.conf file targets travel in
// the settings' allowRead (SRT's read section; profile-level file allows are
// overridden by its later deny-read block). The pinned SRT version emits the
// literal `(allow network*)` marker in this mode; if it is absent the
// profile is not the one this augmentation was reviewed against, so refuse
// to run rather than start a sandbox whose network posture silently differs
// from the declared policy.
if (process.platform === "darwin") {
  const marker = "(allow network*)";
  if (!wrapped.includes(marker)) {
    fail("SRT did not emit the unrestricted-network profile marker; refusing to launch with an unreviewed profile", 79);
  }
  const resolverRules = [
    marker,
    "(allow system-socket (socket-domain AF_UNIX))",
    '(allow file-read-metadata (literal "/etc") (literal "/var"))',
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(allow network-outbound (remote unix-socket (path-literal "/var/run/mDNSResponder")))',
  ].join("\n");
  wrapped = wrapped.replace(marker, resolverRules);
}
const child = spawn(wrapped, { shell: true, stdio: "inherit" });
child.on("exit", (code, signal) => {
  SandboxManager.cleanupAfterCommand();
  if (signal !== null) {
    process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  }
  process.exit(code ?? 0);
});
child.on("error", (error) => {
  console.error(`srt-embed-runner: failed to execute command: ${error.message}`);
  process.exit(1);
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
