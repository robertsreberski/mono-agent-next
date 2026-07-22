#!/usr/bin/env node

/**
 * Stable public and executable CLI surface.
 *
 * Command routing and implementations live in `cli-commands.ts`; keeping this
 * facade deliberately tiny lets callers continue importing `./cli.js` while
 * command families are extracted behind that boundary in reviewable steps.
 */
export * from "./cli-commands.js";
