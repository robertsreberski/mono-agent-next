---
name: live-smoke
description: Run one live mono-agent smoke scenario matching the changed runtime, adapter, TUI, web, or worker boundary. Use for high-risk changes or when asked to smoke test, test live, or drive the TUI.
---

# Live smoke

Live smoke finds integration failures that unit tests cannot. Select the one
scenario that exercises the changed boundary; do not run every section as a
generic merge ritual.

| Changed boundary | Scenario |
|---|---|
| CLI lifecycle, adapter startup, memory wiring | A. Throwaway agent |
| TUI rendering or input | B. TUI via tmux |
| Web server, API, PWA | C. Web via curl |
| Readiness worker transport | D. Real worker with local protocol server |
| Documentation MCP package / stdio boundary | E. Packed documentation MCP |
| Provider routing or provider-specific behavior | A with the explicitly approved real provider |

Add another scenario only when the diff independently changes another live
surface. Paid/provider-backed runs are reserved for provider behavior; local
lifecycle and UI smoke should not spend model calls.

Smoke runs built `dist`, so build the touched dependency closure first:
`pnpm --filter @mono-agent/<pkg>... build`.

## A. Throwaway agent e2e (CLI-level)

```bash
REPO=$(git rev-parse --show-toplevel)
SMOKE=$(mktemp -d /tmp/mono-agent-smoke.XXXX) && cd "$SMOKE"
CLI="$REPO/packages/agent-app/dist/cli.js"
node $CLI init --model claude:claude-sonnet-4-6 --fallback pi:ollama:gemma4:31b
# or hand-write a minimal IDENTITY.md + mono-agent.config.json with a real pi model
# (e.g. pi:openai-codex:gpt-5.5), sandbox {"mode":"native","network":{"mode":"none"}},
# console/webhook disabled unless under test.
node $CLI validate; echo "validate exit: $?"
echo "$SMOKE" > /tmp/mono-agent-smoke-dir

node $CLI start > start.log 2>&1 &
sleep 3 && head -20 start.log            # channel-up lines, error strings
ls .mono-agent/artifacts .mono-agent/trace-sources 2>/dev/null
sqlite3 .mono-agent/memory/memory.db '.tables'   # when memory is under test
```

Cleanup — ALWAYS:

```bash
pkill -f "agent-app/dist/cli.js start"; sleep 1
rm -rf "$(cat /tmp/mono-agent-smoke-dir)" /tmp/mono-agent-smoke-dir
```

## B. TUI smoke via tmux (the `tuismoke` pattern)

```bash
pnpm --filter @mono-agent/tui... build 2>&1 | tail -2
tmux kill-session -t tuismoke 2>/dev/null
tmux new-session -d -s tuismoke -x 140 -y 36 "node packages/tui/dist/bin/mono-agent-tui.js <args>"
sleep 2; tmux capture-pane -t tuismoke -p | grep -v '^$' | tail -20
tmux send-keys -t tuismoke Enter          # keys: Enter, Down, Up, Escape, F3; literal text: -l "text"
sleep 1; tmux capture-pane -t tuismoke -p | grep -v '^$' | sed -n '7,18p'
```

Poll until ready instead of long sleeps:

```bash
for i in $(seq 1 20); do out=$(tmux capture-pane -t tuismoke -p | grep -v '^$'); \
  echo "$out" | grep -q '<ready marker>' && break; sleep 1; done
```

Teardown:

```bash
tmux send-keys -t tuismoke Escape 2>/dev/null; tmux send-keys -t tuismoke C-c C-c 2>/dev/null
sleep 1; tmux kill-session -t tuismoke 2>/dev/null
```

## C. Web PWA smoke (web console)

```bash
node packages/agent-app/dist/cli.js web run --loopback --port 5050 &
for i in $(seq 1 25); do curl -fsS --max-time 3 http://127.0.0.1:5050/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:5050/api/v1/bootstrap    # assert on the JSON body
# LAN variant: web run --host 0.0.0.0 --port 5050
```

## D. Readiness-probe worker (real Worker vs a fake provider)

`packages/agent-app/dist/readiness-probe-worker.js` runs each model route's live
probe turn in an isolated `worker_threads.Worker`; the unit suite only reaches it
through a synthetic `run`/`workerUrl` seam, so the real file is smoke-only.
`mono-agent init` spawns it as its route probe — point the primary model's local
provider at a fake OpenAI-compatible server so the worker completes a real turn
without a paid provider:

```bash
REPO=$(git rev-parse --show-toplevel)
# 1. Fake OpenAI-compatible provider on :11499 — answers the probe's /v1/chat/completions.
node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({id:"p",object:"chat.completion",choices:[{index:0,message:{role:"assistant",content:"ready"},finish_reason:"stop"}]}))})}).listen(11499,"127.0.0.1")' & FAKE=$!

# 2. Init a throwaway agent whose ollama-compat route resolves to the fake (ollama base -> <root>/v1).
SMOKE=$(mktemp -d /tmp/mono-agent-smoke.XXXX) && cd "$SMOKE"
MONO_AGENT_LOCAL_PROVIDER_TYPE=ollama MONO_AGENT_LOCAL_PROVIDER_BASE_URL=http://127.0.0.1:11499 \
  node "$REPO/packages/agent-app/dist/cli.js" init --model pi:ollama:probe-model 2>&1 | tail -25
# init's route probe forks the REAL readiness-probe-worker.js; a "verified"/route-ready line
# (not a timeout) proves the worker spawned, ran a turn, and posted a result back.

kill "$FAKE" 2>/dev/null; rm -rf "$SMOKE"
```

The worker drains its own stdout/stderr and lets only structured messages cross
`workerData`, so a hang that ends in a `timeout` verdict (rather than a
`verified`/`provider_failed` result) means the worker never posted back — that
Worker transport is exactly what this scenario proves and no unit test can.

## E. Packed documentation MCP

Use the package-owned smoke to prove the publish boundary rather than only the
workspace source. It builds a tarball in a throwaway directory, installs that
tarball as a clean consumer, launches the installed `mono-agent-docs-mcp` bin
over real stdio, performs a composer-scoped hybrid query, reads the returned
chunk resource, prints one JSON evidence line, and removes the directory:

```bash
pnpm --filter @mono-agent/docs-mcp run build
pnpm --filter @mono-agent/docs-mcp run smoke
```

The smoke makes no provider call and does not register an MCP server in Codex,
Claude Code, or a user config. Success requires `"transport":"packed-stdio"`
and a `mono-agent-docs://chunk/...` top result in the emitted JSON.

## Gotchas

- pi 0.80 reports provider failures as a terse "Connection error." — failover
  noise, not necessarily your bug. Check which model actually answered.
- Verify WHICH dist you're exercising (worktree vs main repo) before trusting results.
- Never touch `~/personal-agent` or `~/a8c-agents/*` for smoke — that's the live
  fleet (see `fleet-deploy`). All smoke lives in `/tmp` throwaway dirs and named
  tmux sessions, and gets cleaned up.
- Capture evidence (pane captures, log greps, curl bodies) and quote it in your
  report; a smoke claim without captured output doesn't count.
