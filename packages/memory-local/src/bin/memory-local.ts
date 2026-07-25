#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { runMemoryLocalCli } from "../cli.js";

process.exitCode = await runMemoryLocalCli(process.argv.slice(2));
