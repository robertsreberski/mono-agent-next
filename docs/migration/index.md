---
title: "Migration"
description: "Plan and rehearse a mono-agent v0 to v1 transition without publishing packages or changing a live consumer."
sidebar:
  order: 0
---

Source beta proves that the v1 repository can build, pack, clean-install, and
run representative projects. It does not authorize package publication,
consumer deployment, service repointing, data cutover, a production soak, or
predecessor retirement.

Start with the [v0 to v1 source-beta guide](/migration/v0-to-v1-source-beta/).
It maps each v0 concern to its v1 authority, identifies data that is and is not
adopted, and separates safe source rehearsal from a later reviewed live
cutover.

The source-beta migration artifact is a new project directory containing:

- exact direct production dependencies and a committed lockfile;
- a strict `mono-agent.config.json` selecting each typed module with `$use`;
- project MCP registration in `.mcp.json`;
- instructions and workflows under `skills/`;
- scheduled prompts under `cron/`; and
- product-specific config only for products that are installed independently.

Keep the v0 project, data, config, service definition, and logs read-only and
available throughout rehearsal. A failed rehearsal is abandoned; it does not
mutate or replace the live predecessor.
