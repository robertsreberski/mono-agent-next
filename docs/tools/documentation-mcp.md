---
title: "Documentation MCP companion"
description: "Register the version-matched mono-agent documentation corpus as one ordinary coding-client MCP server."
sidebar:
  order: 2
---

`@mono-agent/docs-mcp` is an optional offline documentation companion. Its
corpus is generated from the same canonical Markdown that builds this website,
and its source and artifact digests are checked during build and tests.

It does not import Core, load agent config, run an agent, register itself, or
receive a privileged host grant.

## Client registration

After installing the exact version, register its executable in the coding
client's standard MCP configuration:

```json
{
  "mcpServers": {
    "mono-agent-docs": {
      "type": "stdio",
      "command": "/absolute/path/to/mono-agent-docs-mcp",
      "args": []
    }
  }
}
```

The packed smoke test writes this exact registration shape, starts the MCP
transport from the parsed entry, lists the server's single tool, and performs
search and read calls. Registration is independent for each selected coding
client.

## Tool contract

The companion exposes only `mono_agent_docs`. Call it first with
`{"action":"search","query":"..."}` and follow the returned exact read target
with `{"action":"read","target":"..."}`. Search returns bounded, deduplicated
sections plus navigation. Read accepts only corpus paths, canonical docs URLs,
or opaque targets issued by the server; unsupported external URLs fail closed.

The companion is version-matched to the source package. It cannot assert that
another installed agent or live service uses the same version.

For an agent project's own model-callable tools, use [Project MCP](/tools/mcp/).
