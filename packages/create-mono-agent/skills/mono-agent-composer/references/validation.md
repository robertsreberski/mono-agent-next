# Validation and smoke

Run commands from the generated agent directory.

## Static contract

```bash
mono-agent validate --config ./mono-agent.config.json
mono-agent inspect --config ./mono-agent.config.json
```

Validation must prove the config, direct dependencies, lockfile selections,
module identities, schemas, routes, policy, and environment references. Fix
every error; do not reinterpret a missing package or credential as success.

After dependencies are present, compose the exact selected-module schema:

```bash
mono-agent config schema \
  --config ./mono-agent.config.json \
  --write
```

Use `mono-agent config explain --config ./mono-agent.config.json [path]` for
redacted field ownership and environment provenance.

## Foreground smoke

```bash
mono-agent start --config ./mono-agent.config.json
```

Exercise the configured channel with one real request and require a real model
response. For the minimal template, send one authenticated request to its
loopback webhook. For multi-runtime, also prove that reported attempt routing
matches the configured runtime/model rather than assuming fallback occurred.
If the selected module owns a model tool, prove it through that same real turn;
static validation does not start the instance or promise that a failed startup
contributed a callable tool. With state-local selected, `RunHistory` must come
from that instance rather than a Core fallback.

Stop the foreground process cleanly and confirm it drains. A renderer exit,
separate product, or successful static validation is not a runtime smoke.

## Failure handling

- Keep provider, authentication, module, and transport failures visible.
- Do not broaden tool or network authority just to make a smoke pass.
- Do not reset memory/state or clear sessions unless the user authorizes the
  data-loss consequence.
- TUI, web, service-macos, and docs MCP are independent products and are not
  installed or enabled by this composer skill.
