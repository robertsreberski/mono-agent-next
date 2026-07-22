#!/usr/bin/env node
import { runPiOAuthLogin } from "./pi-oauth-login.js";

const [provider, ...extra] = process.argv.slice(2);
if (provider === undefined || extra.length > 0) {
  process.stderr.write("Usage: mono-agent-pi-oauth-login <provider>\n");
  process.exitCode = 2;
} else {
  runPiOAuthLogin(provider).catch((error: unknown) => {
    process.stderr.write(`Pi OAuth login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
