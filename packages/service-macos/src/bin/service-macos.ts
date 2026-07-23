#!/usr/bin/env node
import { runServiceMacosCli } from "../index.js";
const runnerScriptPath = process.argv[1];
if (runnerScriptPath === undefined) throw new Error("service-macos executable path is unavailable.");
process.exitCode = await runServiceMacosCli(process.argv.slice(2), { runnerScriptPath });
