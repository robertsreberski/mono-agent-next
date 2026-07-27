---
title: "Install & Prerequisites"
description: "Build mono-agent and install a retained minimal source-preview consumer from project-local tarballs."
sidebar:
  order: 1
---

This page installs the public source workspace. The packages are not published
from this repository, and existing registry artifacts under the same package
names belong to the predecessor repository; do not install or execute them.
A narrow, source-preview-only local-tarball path is documented below for
reviewing a consumer without publishing packages.

## Prerequisites

| Requirement | Minimum | Notes |
| --- | --- | --- |
| Node.js | 22.19.0 | Required by every package. |
| pnpm | 10.16.0 | The workspace pins pnpm 10.28.2 in `package.json`. |
| npm | Node-bundled release | Used for the documented local-tarball consumer install. |
| Git | Current | Required to clone `mono-agent-next`. |
| macOS | Optional | Required only for `@mono-agent/service-macos`; the foreground host and most modules are cross-platform Node.js packages. |

External provider credentials are not required for the packed minimal proof. A
real agent later needs the native authentication expected by its selected
runtime. Telegram, Slack, webhook, OpenAI-compatible API, operator, exporter,
and web secrets are required only when those surfaces are selected or started.

## Clone and install

```bash
git clone https://github.com/robertsreberski/mono-agent-next.git
cd mono-agent-next
corepack enable
pnpm install --frozen-lockfile
```

The install is a workspace operation. A generated agent manifest intentionally
names release versions that are not available from npm, so do not install that
manifest unchanged.

## Build and test

```bash
pnpm build
pnpm typecheck
pnpm test
```

For the smallest real package-boundary proof:

```bash
pnpm run verify:minimal
```

For the separate terminal and browser operator products:

```bash
pnpm run verify:operator-products
```

These scripts use temporary directories and local packed artifacts. They do not
publish packages, use production credentials, or mutate a live consumer.

## Inspect the built executables

Use the built files directly in this source worktree so an older globally
installed command cannot shadow them:

```bash
node packages/cli/dist/bin/mono-agent.js --help
node packages/create-mono-agent/dist/bin/create-mono-agent.js --help
node packages/tui/dist/bin/mono-agent-tui.js --help
```

The agent CLI exposes only validation, inspection, config authoring, module
commands, and foreground start. TUI, web, and macOS service management have
separate executables and lifecycles.

## Render a project without installing it

After `pnpm build`, the source scaffolder can render any closed template:

```bash
SOURCE_ROOT="$(pwd -P)"
SCAFFOLD_PARENT="$(mktemp -d)"
SCAFFOLD_PARENT="$(cd "$SCAFFOLD_PARENT" && pwd -P)"
node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  "$SCAFFOLD_PARENT/mono-agent-minimal" \
  --template minimal

node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  "$SCAFFOLD_PARENT/mono-agent-multi" \
  --template multi-runtime
```

Accepted templates are `minimal`, `personal`, and `multi-runtime`; `minimal` is
the default. The target must be absent or an existing empty real directory;
symlinks, non-directories, and non-empty targets fail closed. Installation
never runs unless `--install` is explicit, so omit that flag during the
source-only preview. The local-tarball path is a separate post-render step; it
does not make `--install` safe before publication.

Publication is protected by a fsynced append-only journal. If a process exits
while temporarily parking an existing empty target, the next invocation
restores or reconciles only the journaled device and inode identities. Safe
artifacts that could not be removed are listed in the JSON result's
`retainedRecoveryPaths` array for manual inspection.

Every template writes:

```text
.env.example
.gitignore
.mono-agent/mono-agent.config.schema.json
AGENTS.md
README.md
mono-agent.config.json
package.json
```

The Personal template additionally writes `.mcp.json`, `cron/.gitkeep`, and
`skills/.gitkeep`. No template writes `.env`, a credential file, a lockfile, or
`node_modules`; a lockfile is created only by a later explicit package-manager
install.

## Install a retained minimal local-tarball consumer

This npm-only recipe supports the minimal template, not Personal or
multi-runtime. Use it only to evaluate exact artifacts built from a reviewed
source checkout. It is not a registry release, publisher-authenticity proof,
deployment, or permission to repoint a live consumer.

The `mktemp` projects above are disposable inspections. For a retained project,
choose a persistent parent explicitly, render a fresh minimal scaffold there,
and keep `SOURCE_ROOT` set to the canonical source checkout:

```bash
PROJECT_PARENT="${MONO_AGENT_PROJECTS_DIR:?export MONO_AGENT_PROJECTS_DIR to a persistent directory}" &&
mkdir -p "$PROJECT_PARENT" &&
PROJECT_PARENT="$(cd "$PROJECT_PARENT" && pwd -P)" &&
AGENT_ROOT="$PROJECT_PARENT/mono-agent-minimal" &&
test ! -e "$AGENT_ROOT" &&
node "$SOURCE_ROOT/packages/create-mono-agent/dist/bin/create-mono-agent.js" \
  "$AGENT_ROOT" \
  --template minimal &&

TARBALL_ROOT="$AGENT_ROOT/vendor/mono-agent" &&
mkdir -p "$TARBALL_ROOT" &&

pnpm --dir "$SOURCE_ROOT/packages/module-sdk" pack \
  --pack-destination "$TARBALL_ROOT" &&
pnpm --dir "$SOURCE_ROOT/packages/core" pack \
  --pack-destination "$TARBALL_ROOT" &&
pnpm --dir "$SOURCE_ROOT/packages/cli" pack \
  --pack-destination "$TARBALL_ROOT" &&
pnpm --dir "$SOURCE_ROOT/packages/runtime-pi" pack \
  --pack-destination "$TARBALL_ROOT" &&
pnpm --dir "$SOURCE_ROOT/packages/channel-webhook" pack \
  --pack-destination "$TARBALL_ROOT"
```

Rewrite only the generated first-party dependency provenance, and bind every
transitive first-party edge to the same direct archive. The exact five-package
check fails closed if the template changes:

```bash
cd "$AGENT_ROOT" &&
node --input-type=module <<'NODE'
import { access, readFile, writeFile } from "node:fs/promises";

const names = [
  "@mono-agent/module-sdk",
  "@mono-agent/core",
  "@mono-agent/cli",
  "@mono-agent/runtime-pi",
  "@mono-agent/channel-webhook",
];
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const actualNames = Object.keys(manifest.dependencies ?? {}).sort();
if (JSON.stringify(actualNames) !== JSON.stringify([...names].sort())) {
  throw new Error("The minimal scaffold dependency set changed; stop and review it.");
}
for (const name of names) {
  const version = manifest.dependencies[name];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Unexpected generated version for ${name}.`);
  }
  const filename = `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
  const specification = `file:vendor/mono-agent/${filename}`;
  await access(specification.slice("file:".length));
  manifest.dependencies[name] = specification;
}
manifest.overrides = Object.fromEntries(names.map((name) => [name, `$${name}`]));
await writeFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE
```

Keep the source-preview scope fail-closed for the colliding package names, then
install from the rewritten manifest:

```bash
cd "$AGENT_ROOT" &&
printf '%s\n' \
  '@mono-agent:registry=http://127.0.0.1:9/' \
  'fetch-retries=0' \
  'fetch-retry-mintimeout=1' \
  'fetch-retry-maxtimeout=1' > .npmrc &&
npm install \
  '--@mono-agent:registry=http://127.0.0.1:9/' \
  --ignore-scripts \
  --no-audit \
  --no-fund &&
npm ci \
  '--@mono-agent:registry=http://127.0.0.1:9/' \
  --ignore-scripts \
  --no-audit \
  --no-fund
```

The quoted command-line scoped registry flag outranks ambient npm configuration
and prevents a missing first-party artifact from falling back to a predecessor
package. The manifest overrides prevent npm from requesting registry metadata
for first-party transitive edges; they do not change where npm resolves
unscoped or third-party dependencies. The second install command removes the
installed tree and proves that the lockfile can recreate it from the retained
tarballs. Keep the `.npmrc`, command-line flag, and manifest overrides during
the source preview; removing them is part of a later, explicit migration to
reviewed registry packages.

npm writes each direct dependency as a project-relative specification such as
`file:vendor/mono-agent/<packed-filename>.tgz`. The `$use` value in
`mono-agent.config.json` remains the literal package name
`@mono-agent/runtime-pi`; a path is never a `$use` value.

For a selected module, Core accepts only a lowercase `.tgz` dependency
specification with a lexically project-relative `file:` locator. The npm
`package-lock.json` root must record that same locator, the installed package
version, and a syntactically valid canonical SHA-512 SRI. Core validates the
installed package as a real project-contained npm directory, but it does not
reopen or attest the retained archive bytes at startup. This source-preview
escape is deliberately npm-only; pnpm lockfiles remain supported for registry
dependencies. Local directories, parent or absolute paths, `file://`, `link:`,
`workspace:`, aliases, Git sources, HTTP sources, and bare archive paths remain
unsupported.

Keep `vendor/mono-agent/`, `package.json`, and the root lockfile together. The
tarballs are retained project provenance needed for a clean reinstall, not a
disposable download cache. `npm ci` checks the retained bytes against the lock
integrity, and `pnpm run verify:minimal` independently recomputes every staged
tarball digest. Neither check establishes who authored or reviewed that
executable code. Repack every first-party dependency and regenerate the
lockfile rather than mixing source revisions.

With the webhook secret exported, the installed project can now use its exact
local CLI:

```bash
cd "$AGENT_ROOT" &&
export WEBHOOK_API_KEY='replace-with-a-long-random-token' &&
npm run validate &&
npm run schema
```

Starting a real turn additionally requires the native authentication documented
by the selected runtime. Continue with the
[first-agent workflow](/getting-started/quickstart/) before starting or adopting
the project.

## Secret boundary

Mono-agent does not implicitly load `.env` or `.env.example`. Export variables
in the process environment or inject them through the eventual service product.
Config contains only explicit references:

```json
{
  "apiKey": { "$env": "WEBHOOK_API_KEY" }
}
```

Core resolves a reference only when the owning module schema marks that path as
environment-eligible. Secret-marked paths reject inline values, missing or empty
variables fail validation, and diagnostic/provenance output redacts resolved
values. Keep provider-native credential stores owner-private as required by the
selected runtime.

## Registry installation remains a later phase

This source rebuild exposes no supported registry installation path. A future
release procedure must first pack the exact candidate, verify package contents
and identities, publish under reviewed authority, and prove a clean registry
install. The local-tarball escape above does not satisfy or authorize any of
those release steps.

Continue with the [first-agent proof](/getting-started/quickstart/).
