---
name: mono-agent-composer
description: Build or repair a config-first mono-agent v1 project with the bundled scaffolder, strict validation, and one real foreground smoke test.
---

# Mono Agent Composer

Create a runnable mono-agent v1 project from one strict
`mono-agent.config.json`. Prefer the existing `create-mono-agent` templates and
public CLI contracts; do not invent host glue or read package internals to guess
configuration.

## Workflow

1. Establish the intended agent, runtime/model routes, channels, durable
   capabilities, tool policy, sandbox, and smoke test.
2. Read [the v1 config reference](references/config.md).
3. From the built v1 source checkout, scaffold a new absent directory with one
   explicit template:

   ```bash
   node packages/create-mono-agent/dist/bin/create-mono-agent.js \
     ./my-agent \
     --template minimal
   # alternatives: personal, multi-runtime
   ```

   Scaffolding does not install dependencies unless the user separately
   authorizes `--install`.
4. Edit only the generated public inputs. Keep secrets out of JSON and use the
   generated names-only environment references.
5. Follow [validation and smoke](references/validation.md). Do not claim success
   until strict validation and a real runtime/channel turn pass.

## Boundaries

- Preserve existing projects and knowledge. The scaffolder is no-clobber.
- Select modules only through literal `$use` package names that are direct
  production dependencies in the project lockfile.
- Keep runtime fallbacks explicit and ordered. Never hide provider failure
  behind fake success.
- Treat memory and state as optional selected modules and durable user data.
- Keep TUI, web, service management, and the documentation MCP companion as
  separately installed products; package presence does not activate them.
- Do not install npm packages, pair MCP servers, publish, deploy, or mutate live
  services unless the user explicitly asks for that separate action.

## Done

- The config describes the requested product without hidden capabilities.
- The project-local validation command in
  [validation and smoke](references/validation.md) exits successfully.
- The configured foreground agent completes the agreed real smoke test.
- No credential value or local environment file was exposed or committed.
