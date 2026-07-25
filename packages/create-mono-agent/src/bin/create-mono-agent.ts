#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { runCreateMonoAgentCli } from "../index.js";

process.exitCode = await runCreateMonoAgentCli(process.argv.slice(2), undefined, {
  invocationName: "create-mono-agent",
});
