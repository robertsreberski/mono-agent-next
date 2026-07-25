---
name: live-smoke
description: Run one supported live mono-agent smoke for CLI/Pi/webhook, TUI, web, or documentation-MCP changes, or record an explicit focused-proof substitution when no repository scenario covers the changed boundary.
---

# Live smoke

Select the single scenario that exercises the changed boundary. Build the
touched dependency closure first and record the exact checkout SHA. A smoke run
uses built `dist`; source inspection alone is not evidence.

| Changed boundary | Scenario |
| --- | --- |
| CLI lifecycle, runtime, or webhook startup | A. Hermetic minimal agent |
| TUI rendering or input | B. TUI via tmux |
| Web server or browser API | C. Isolated web process |
| Documentation MCP package or stdio | D. Packed documentation MCP |
| Any other runtime, channel, storage, sandbox, trigger, service, or shared-contract boundary | E. Focused-proof substitution |

Add a second scenario only when the diff independently changes another live
surface. Provider-backed smoke requires explicit authorization and configured
credentials; local lifecycle and product checks use their hermetic paths.
Scenario E does not claim live coverage; it makes the missing scenario and its
focused substitute explicit.

## A. Hermetic minimal agent

Use the repository-owned packed proof. It builds and packs the five-package
runtime closure, clean-installs a generated minimal project, starts a local
OpenAI-compatible provider and authenticated webhook, completes one turn, and
proves signal-driven shutdown:

```bash
pnpm run verify:v1-minimal
```

The proof owns and removes its temporary directory and child processes. For a
provider-specific change, use a separately authorized throwaway config and
capture the selected runtime/model plus the terminal result.

## B. TUI via tmux

Connect the built TUI to an already running throwaway operator fixture or the
repository operator-products proof. Never infer authority to connect to an
unrelated endpoint.

```bash
pnpm --filter @mono-agent/tui... run build
tmux kill-session -t mono-agent-tui-smoke 2>/dev/null || true
tmux new-session -d -s mono-agent-tui-smoke -x 140 -y 36 \
  "node packages/tui/dist/bin/mono-agent-tui.js <throwaway-args>"
tmux capture-pane -t mono-agent-tui-smoke -p
tmux send-keys -t mono-agent-tui-smoke -l "hello"
tmux send-keys -t mono-agent-tui-smoke Enter
tmux capture-pane -t mono-agent-tui-smoke -p
tmux kill-session -t mono-agent-tui-smoke
```

Use bounded poll loops for readiness instead of long sleeps. Capture the pane
that proves the changed interaction and confirm teardown.

## C. Isolated web process

Use the standalone web binary, an ephemeral port, one exact PID, and one
throwaway root:

```bash
SMOKE_ROOT=$(mktemp -d /tmp/mono-agent-web-smoke.XXXXXX)
mkdir -m 700 "$SMOKE_ROOT/registry"
cat >"$SMOKE_ROOT/web.config.json" <<'JSON'
{
  "configVersion": 1,
  "listen": { "host": "127.0.0.1", "port": 0 },
  "auth": { "token": { "$env": "WEB_SMOKE_TOKEN" } },
  "dataDirectory": "./data",
  "agentRegistries": ["./registry"]
}
JSON
WEB_SMOKE_TOKEN=web-smoke-token-0123456789 \
  node packages/web/dist/bin.js "$SMOKE_ROOT/web.config.json" \
  >"$SMOKE_ROOT/web.log" 2>&1 &
WEB_SMOKE_PID=$!
```

The relative config paths resolve under `SMOKE_ROOT`, so the process uses only
the throwaway registry and data directory. Poll the URL printed in
`web.log`, request its exact `/healthz`, and assert `{"status":"healthy"}`.
Then send `TERM` to `WEB_SMOKE_PID`, wait for that PID, and remove only the
validated `mono-agent-web-smoke.*` directory.

For the complete operator/TUI/web integration boundary, use:

```bash
pnpm run verify:v1-operator-products
```

## D. Packed documentation MCP

```bash
pnpm --filter @mono-agent/docs-mcp run build
pnpm --filter @mono-agent/docs-mcp run smoke
```

The package-owned smoke clean-installs its tarball, drives real stdio, checks a
query plus returned resource, and removes the temporary consumer. It makes no
provider call and does not register an MCP server in a user configuration.

## E. Focused-proof substitution

Use this only when A-D do not execute the changed boundary. Name that gap, then
run the owning package's dependency-closure build, focused tests, typecheck,
and closest package-owned integration or contract proof:

```bash
pnpm --filter @mono-agent/<package>... run build
pnpm --filter @mono-agent/<package> test
pnpm --filter @mono-agent/<package> run typecheck
```

Record the exact substitute and do not report it as a live smoke. Never broaden
credentials, service mutation, or live-consumer scope merely to manufacture a
scenario.

## Report

Report PASS or FAIL, the exact command, the checkout SHA, one bounded evidence
snippet, and cleanup confirmation. For scenario E, report `SUBSTITUTED` and the
uncovered boundary. For a failure, include the smallest reproduction and do
not hide provider, transport, or lifecycle errors behind a fallback.
