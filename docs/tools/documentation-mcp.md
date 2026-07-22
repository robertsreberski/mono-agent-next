---
title: "Documentation MCP companion"
description: "Install, register, inspect, and diagnose the version-matched offline documentation MCP companion for Codex, Claude Code, or an explicit agent runtime."
sidebar:
  order: 3
---

`@mono-agent/docs-mcp` gives an AI coding harness one read-only tool for
searching **and reading** the version-matched mono-agent documentation and the
authoritative `mono-agent-composer` references. Search results are useful
2–3k-character maps; the same tool expands the best result into a guided window
up to 10k characters, resolves documentation cross-links offline, and supplies
exact continuation actions. This lets the composer build from the documented
contract instead of guessing from a small chunk or searching package source.

This is primarily an **authoring-harness companion** for Codex and Claude Code.
It is not injected into agents created by mono-agent, and it does not change an
agent's `tools.mcpConfigPath` or `mcp.json`.

## Install it with the composer

The normal installer copies the composer skill and pairs the exact same
mono-agent version of the documentation server with every selected harness CLI
that is available:

```bash
mono-agent install-skill
mono-agent install-skill --target codex
mono-agent install-skill --target claude --force
```

The pairing is transactional with the skill install. An existing matching entry
is left alone; an older entry recognized as mono-agent-managed is upgraded. An
unrelated server using the reserved `mono-agent-docs` name is never overwritten,
even with `--force`. If one selected harness CLI is missing, the available target
is configured and the CLI prints the exact manual command for the missing one. If
none of the selected harness CLIs is available, nothing is changed.

Use `--no-docs-mcp` when you intentionally want only the composer files:

```bash
mono-agent install-skill --no-docs-mcp
```

Project-skill maintenance (`--project --check` and `--project --update`) never
changes harness MCP configuration. Start a new Codex or Claude Code session after
installation so it discovers both the skill and server.

## Manual registration

Use the version matching the installed `@mono-agent/agent-app` package:

```bash
MONO_AGENT_VERSION="$(mono-agent --version)"
MONO_AGENT_VERSION="${MONO_AGENT_VERSION#mono-agent }"
codex mcp add mono-agent-docs -- npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION"
claude mcp add --scope user mono-agent-docs -- npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION"
```

These registrations intentionally end at the package name. With no arguments,
the executable is the long-running stdio MCP subprocess. Do not register
`--check` or `--version`; those are terminating commands for a human shell.

The exact version matters: the package contains a prebuilt documentation corpus,
so pairing different versions can give the composer contracts that do not match
the CLI it is configuring.

You can also attach the server to a mono-agent runtime explicitly. This is
separate from the authoring-harness pairing:

```json
{
  "mcpServers": {
    "mono-agent-docs": {
      "command": "npx",
      "args": ["-y", "@mono-agent/docs-mcp@<matching-version>"]
    }
  }
}
```

Point `tools.mcpConfigPath` at that file as described in [MCP servers](/tools/mcp/).

## Tool contract

The server exposes one action-based tool, `mono_agent_docs`. Start with search:

```json
{
  "action": "search",
  "query": "How do I configure fallback models?",
  "scope": "composer",
  "limit": 5
}
```

| Input | Contract |
| --- | --- |
| `action` | Required. `search` finds relevant sections; `read` expands a target. |
| `query` | Search only. Required natural-language question or exact config, CLI, environment, or package identifier; 3–500 characters. |
| `limit` | Search only. Optional result count from 1–8; default `5`. |
| `scope` | Search only. `all` (default), `composer`, or `docs`. Use `composer` for configuration and capability questions. |
| `target` | Read only. Required target returned by search/navigation, logical corpus path, public route, or canonical docs URL. |

Treat search excerpts as a map rather than the complete answer. Each result
includes source provenance, a Markdown excerpt no larger than 3,000 characters,
normalized `internalLinks`, and a stable `readTarget`. Expand the best result:

```json
{
  "action": "read",
  "target": "mono-agent-docs://chunk/<chunkId>"
}
```

`read` accepts any target returned by the tool, including a chunk URI,
`previousTarget`, `nextTarget`, logical corpus path such as
`docs/config/reference.md#runtime`, public route such as `/config/reference/`,
or canonical docs URL. It returns an anchored Markdown window no larger than
10,000 characters. Long documents expose exact, non-overlapping previous and
next targets. Cross-links expose a normalized `readTarget`; follow it with
another `action: "read"` call rather than trying to interpret the original URL
or chunk id yourself.

Every tool response reports schema `mono-agent.docs.v2`, the documentation
version, corpus digest, and `navigation` with concrete next calls. Unsupported
or missing targets return structured `unsupported_target` or
`target_not_found` errors plus a recovery search action.
`mono-agent-docs://chunk/{chunkId}` remains a readable `text/markdown` resource
for MCP clients that prefer resources. It renders the same expanded guided
window as `action: "read"` rather than replaying the small retrieval chunk, but
does not wrap that Markdown in the tool-response schema.

The former `search_mono_agent_docs` name is not an alias. Install the exact
matching package version and use `mono_agent_docs`; this keeps the model-facing
contract unambiguous.

The tool declares itself read-only, idempotent, non-destructive, and closed-world.

## What is searched

The published corpus is built from two versioned sources:

- public pages under `docs/`, excluding internal skill/process material; and
- the bundled `mono-agent-composer` skill plus its authoritative references.

Markdown is indexed deterministically by heading and block boundaries. The
package ships small retrieval chunks with precomputed local Potion Base 8M
embeddings, plus checked normalized documents, GitHub-compatible heading
anchors, and chunk-to-document offsets for reading. Corpus generation validates
every internal documentation link. At query time the server combines local
semantic similarity with exact-token BM25 ranking through reciprocal-rank fusion,
deduplicates by section, expands ranked hits around their source positions, and
limits one source file from crowding out the rest. Exact identifiers such as
`channels.plugins[]`, `MONO_AGENT_MCP_CONFIG_PATH`, and package names therefore
remain searchable alongside natural-language questions.

No website crawl, provider API, model download, filesystem write, or telemetry is
performed while the server runs. Search, reads, cross-link resolution, and
continuation are all served from the exact-version package. Corpus metadata,
document/chunk artifact checksums, positions, dimensions, and finite vector
values are validated before retrieval; corrupt or mismatched artifacts fail
closed.

## Package architecture

The authoring and runtime paths are deliberately separate:

```text
package build  -> docs + composer references -> chunks + local embeddings -> corpus
search action  -> validate corpus -> semantic/BM25 fusion -> excerpts + read targets
read action    -> validate corpus -> resolve target -> anchored window + navigation
chunk resource -> validate corpus -> resolve chunk -> anchored Markdown window
```

The build pipeline lives in `scripts/generate-corpus.mjs`; it is the only stage
that reads repository documentation and writes corpus artifacts. At runtime,
`src/corpus.ts` validates and loads those packaged artifacts, `src/search.ts`
ranks search results locally, `src/reader.ts` resolves supported targets and
builds expanded windows, links, continuations, and recovery actions, and
`src/server.ts` dispatches the search/read actions plus the resource template.

Programmatic hosts may call `createMonoAgentDocsMcpServer()`. The factory returns
an unconnected MCP SDK server, so the host must attach and own its transport.
The `mono-agent-docs-mcp` executable adds the ready-made stdio transport and is
the normal subprocess used by Codex, Claude Code, or `tools.mcpConfigPath`.

## Diagnostics

Run the published executable directly when checking an installation:

```bash
MONO_AGENT_VERSION="$(mono-agent --version)"
MONO_AGENT_VERSION="${MONO_AGENT_VERSION#mono-agent }"
npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION" --version
npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION" --check
```

`--version` prints the package, docs, corpus, and embedding-model identities as
JSON. `--check` is a human diagnostic: it validates the bundled corpus, performs
a representative composer-scoped search, prints JSON, and exits. With no flag,
stdout is reserved for MCP stdio protocol messages; startup or validation
failures are written to stderr and exit nonzero.
