# mono-agent architecture

This is the maintainer map for the repository. Start here when deciding where a change belongs; use the package README for the detailed contract of that package.

## System shape

`@mono-agent/agent-app` is the config-first composition root. It loads one validated config, resolves channel drivers, builds one responder per active channel, and publishes lifecycle/traceability state. The execution path then crosses narrow package boundaries:

```text
channel adapter
  -> agent-contracts request/stream interfaces
  -> agent-app responder composition
  -> agent-harness turn orchestration
  -> runtime-adapter
  -> agent-runtime provider implementation

optional side paths
  -> memory
  -> observability
  -> operator TUI/web surfaces
```

The exact workspace graph and package ownership descriptions are generated in [`PACKAGES.md`](./PACKAGES.md). The rules are enforced by `pnpm run check:architecture`.

## Where changes belong

| Change | Primary owner |
| --- | --- |
| Shared request, stream, channel, or host-safety contract | `packages/agent-contracts` |
| Config schema, validation, or source precedence | `packages/config` |
| Host/CLI/config composition | `packages/agent-app` |
| One request, tools, MCP, approvals, or structured output | `packages/agent-harness` |
| Provider routing or sandbox facade | `packages/runtime-adapter` |
| Provider implementation or runtime sessions | `packages/agent-runtime` |
| Transport-specific behavior | The matching `*-adapter` package |
| Memory persistence, recall, or maintenance | `packages/memory` or an explicitly selected plugin backend |
| Run artifacts, trace discovery, or exporters | `packages/observability` |
| Terminal/browser operator experience | `packages/tui`, `packages/web`, or `packages/operator-adapter` |

Choose the lowest rung in [`docs/reference/capability-ladder.md`](./docs/reference/capability-ladder.md). A shared contract change is the last resort, not the default home for reusable-looking code.

## Agent-app internals

`app-controller.ts` owns lifecycle state and delegates operations. Each `app-controller-*.ts` module declares the narrow controller port it needs; operation modules must not import the concrete controller. Cross-cutting service logic lives in focused modules such as `background-log-maintenance.ts`, `doctor-observability.ts`, and `managed-web-logs.ts` rather than returning to the CLI/controller entrypoints.

The normal lifecycle is:

1. Strictly load config and resolve channel drivers.
2. Establish sandbox, traceability, exporters, and continuation services.
3. Start configured channels and their responders.
4. Publish the completed startup snapshot.
5. On reload or stop, block new work, stop transports, dispose responders/runtimes, and close shared services with bounded waits.

## Generated surfaces

Do not hand-edit generated blocks or inventories:

- `pnpm run generate:package-docs` owns catalog metadata, `PACKAGES.md`, and package-directory tables.
- `pnpm run generate:public-api-docs` owns package public API inventories and migration subpath inventories.
- `pnpm run generate:config-reference` owns the JSON schema and config-reference tables from the typed config metadata.

Architecture and docs checks fail when these outputs drift. Narrative package responsibilities and examples remain hand-authored beside their generated blocks.

## Change discipline

- Keep one responsibility per package and one reason to change per module.
- Prefer explicit typed inputs over reaching into a composition root's full state.
- Keep queues, retained samples, log files, streams, and shutdown waits bounded.
- Preserve real failure states; do not replace provider or transport failures with fallback success.
- Add behavior tests at the owning boundary, then select verification from the diff's risk.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development and verification workflow.
