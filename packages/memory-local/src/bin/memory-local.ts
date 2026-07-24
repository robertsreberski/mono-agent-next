#!/usr/bin/env node
import { runMemoryLocalCli } from "../cli.js";

process.exitCode = await runMemoryLocalCli(process.argv.slice(2));
