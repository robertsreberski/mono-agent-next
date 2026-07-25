#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { runCli } from "../index.js";

process.exitCode = await runCli(process.argv.slice(2));
