---
title: "Terminal operator (mono-agent-tui)"
description: "Run the standalone pi-tui renderer against an authenticated mono-agent operator endpoint."
sidebar:
  order: 4
---

`@mono-agent/tui` is a standalone terminal product. It connects to an
already-running agent through `@mono-agent/operator`, renders normalized
conversation state with pi-tui, and never loads agent config, starts a runtime,
or owns the agent process.

The binary is `mono-agent-tui`. The old host command, embedded responder,
`--local`, replay/config panes, and conversational self-configuration are not
part of this product.

## Direct connection

During the source preview, build the product from this workspace, place the
bearer in an environment variable, and pass the channel's loopback root URL:

```bash
pnpm --filter @mono-agent/tui... run build
export MONO_AGENT_OPERATOR_TOKEN="replace-with-a-long-random-token"
node packages/tui/dist/bin/mono-agent-tui.js \
  --endpoint http://127.0.0.1:52341
```

Direct connections require a token environment. The default name is
`MONO_AGENT_OPERATOR_TOKEN`; select another without putting the secret in the
process arguments:

```bash
node packages/tui/dist/bin/mono-agent-tui.js \
  --endpoint http://127.0.0.1:52341 \
  --token-env EXAMPLE_OPERATOR_TOKEN
```

There is intentionally no `--token` flag.

## Owner-private discovery

With no `--endpoint`, the TUI reads the shared operator registry. The default
directory is `~/.mono-agent/trace-sources`; `--registry` may be repeated to
select explicit roots:

```bash
node packages/tui/dist/bin/mono-agent-tui.js
node packages/tui/dist/bin/mono-agent-tui.js --agent example-agent
node packages/tui/dist/bin/mono-agent-tui.js \
  --registry /Users/example/agents/example-agent/.mono-agent/trace-sources \
  --agent example-agent
```

One live entry is selected automatically. Multiple live entries require
`--agent <id|label>`; an ambiguous label requires the id. A descriptor carries
only the bearer environment-variable name, which the client resolves from the
TUI process environment.

Registry directories and entries must be current-user-owned and inaccessible
to group/other users. Symlinked directories or files, multi-link files,
malformed descriptors, and registry identities that change while opening or
reading fail closed. At startup and immediately before each discovered turn,
the TUI binds `/v1/info` to the selected agent id, PID, and process start time.

## Turn behavior and controls

The renderer displays assistant markdown and bounded status for reasoning,
activity, usage, completion, cancellation, and errors. All actions are gated by
the capabilities and shared state returned from `@mono-agent/operator`.

| Input | Action |
| --- | --- |
| ordinary text | Start a turn when idle; during a compatible active turn, offer live input. |
| `Escape` or `/cancel` | Request cancellation when the endpoint advertises it. |
| `/runtime <instance\|default>` | Set or clear the next-turn runtime-instance override. |
| `/model <ref\|default>` | Set or clear the next-turn model override. Advertised models are an allowlist. |
| `/effort <level\|default>` | Set or clear the next-turn effort override. Advertised effort values are an allowlist. |
| `/answer {"question":"value","other":["value-1","value-2"]}` | Losslessly answer every pending question, including punctuation-rich choices, free text, and multi-select values. |
| `/help` | Show the in-product command summary. |
| `/exit` or `/quit` | Close only this renderer. |

When model or effort catalogs are omitted, the operator layer accepts a
bounded protocol-valid value and leaves final validation to Core and the
selected runtime. Unsupported actions remain unavailable; the TUI does not
invent a fallback protocol.

Closing the renderer aborts its open stream and can therefore cancel that
exact in-flight turn at the channel boundary. It never sends a process or
service stop request, so the agent and its other channels keep running.

## CLI flags

| Flag | Description |
| --- | --- |
| `--endpoint <url>` | Connect directly to a loopback operator endpoint. |
| `--token-env <name>` | Direct mode only; read the bearer from this environment variable. |
| `--registry <dir>` | Add an owner-private discovery root; repeatable. |
| `--agent <id\|label>` | Select one discovered agent. |
| `--conversation <id>` | Use a stable conversation id; the default is a new random TUI id. |
| `--model <ref>` | Set an initial eligible model override. |
| `--effort <level>` | Set an initial eligible effort override. |
| `--title <text>` | Override the renderer header. |
| `-h`, `--help` | Print help and exit. |

The CLI requires an interactive TTY. Programmatic tests and embeddings can
inject a pi-tui `Terminal` while still using the same shared client:

```ts
import { startMonoAgentTui } from "@mono-agent/tui";

const handle = await startMonoAgentTui({
  endpoint: "http://127.0.0.1:52341",
  token: process.env.MONO_AGENT_OPERATOR_TOKEN,
  terminal,
});

await handle.waitUntilExit();
```

## Current scope

This first runnable product slice provides direct/discovered text chat,
streaming assistant output, activity/usage status, capability-gated
cancellation, live input, AskUser answers, and model/effort overrides. The
currently paired `@mono-agent/channel-operator` advertises cancellation,
runtime overrides, and health; the other controls stay unavailable until a
selected endpoint implements them.

The product does not include local/embedded agent execution, recorded-run
replay, config inspection, file attachments, self-configuration, product
persistence, or agent lifecycle commands.

## Related

- [Operator channel](/channels/tui/) — selected endpoint, auth, bounds, and current capabilities.
- [Web operator](/observability/web-console/) — independently configured durable browser product.
- [architecture](/reference/architecture/) — shared operator and renderer boundaries.
