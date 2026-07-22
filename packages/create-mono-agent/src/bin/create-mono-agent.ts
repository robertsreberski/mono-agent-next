#!/usr/bin/env node

import { runCreateMonoAgentCli } from "../index.js";

process.exitCode = await runCreateMonoAgentCli(process.argv.slice(2), undefined, {
  invocationName: "create-mono-agent",
});
