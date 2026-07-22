---
name: fleet-deploy
description: Deploy or restart only explicitly requested mono-agent consumers and prove their bounded health. Use when asked to deploy, restart named agents, or get a change live. Do not infer a full-fleet rollout from a release or merge.
---

# Exact-target deployment

Deployment is consumer adoption, not release aftercare. Resolve the user's named
targets before changing anything and leave every other agent, service, and web
console untouched.

> Bootstrap guard: the root `AGENTS.md` successor-safety section overrides this
> workflow. While that section is present, stop before any deployment or
> restart. The private predecessor remains the live v0 source until the reviewed
> canonical-name cutover explicitly removes the guard.

## Runtime topology

- The normal mono-agent `main` checkout is the live source for the global local
  CLI and Personal Agent. Its checkout-backed provenance is intentional.
- Other `com.mono-agent.*` instances may use copied managed runtimes. Their
  serving process and instance wrappers must agree with that managed snapshot.
- `~/a8c-agents` has its own package graph, lifecycle manager, and runbook. It
  is never part of an inferred mono-agent fleet deployment.

Development still happens in worktrees. The live `main` checkout stays clean,
and is advanced only to an already-reviewed commit when deployment is requested.

## 1. Classify the request

Use the narrowest operation:

| Request | Operation |
|---|---|
| Restart an unchanged target | Restart only that target; do not rebuild |
| Adopt a reviewed mono-agent commit in Personal Agent | Fast-forward clean `main`, install/build, restart Personal Agent |
| Adopt a reviewed commit in another named mono-agent | Prepare clean `main`, then restart only the named instance so it installs its managed runtime |
| Adopt a published version in A8C | Use the A8C dependency-upgrade runbook |

A release does not imply any row in this table.

## 2. Prepare checkout code only when needed

```bash
MONO_DEPLOY_REPO=/Users/example/Personal_Repositories/mono-agent
test -z "$(git -C "$MONO_DEPLOY_REPO" status --porcelain)"
git -C "$MONO_DEPLOY_REPO" fetch origin main
git -C "$MONO_DEPLOY_REPO" pull --ff-only origin main
git -C "$MONO_DEPLOY_REPO" rev-parse HEAD
cd "$MONO_DEPLOY_REPO"
pnpm install --frozen-lockfile
pnpm run build
```

Run this block once per adopted commit, not once per consumer. Never edit, stash,
reset, or test a feature branch in the live checkout. If it is dirty or cannot
fast-forward, stop and preserve the state.

## 3. Personal Agent

Personal Agent intentionally follows the clean local `main` checkout. Restart
it directly through its existing LaunchAgent:

```bash
PERSONAL_LABEL=com.mono-agent.personal-agent-059657c8
launchctl kickstart -k "gui/$(id -u)/$PERSONAL_LABEL"
launchctl print "gui/$(id -u)/$PERSONAL_LABEL" | grep -E 'state =|pid =|last exit code'
cd "$HOME/personal-agent"
mono-agent --version
mono-agent validate
mono-agent status
```

Then prove the running command actually resolves into the mono-agent checkout:

```bash
PERSONAL_PID=$(launchctl print "gui/$(id -u)/$PERSONAL_LABEL" | awk '/pid =/{print $3; exit}')
test -n "$PERSONAL_PID"
ps -p "$PERSONAL_PID" -o pid=,command=
git -C "$MONO_DEPLOY_REPO" rev-parse HEAD
```

Use a bounded error tail only; do not launch a full log or fleet audit:

```bash
tail -n 25 "$HOME/.mono-agent/logs/$PERSONAL_LABEL.err.log"
```

## 4. Other named mono-agent instances

For each explicitly named instance, resolve its config directory and service
label, then operate from that directory:

```bash
cd <exact-instance-directory>
mono-agent restart
mono-agent validate
mono-agent status
tail -n 25 "$HOME/.mono-agent/logs/<exact-label>.err.log"
```

Verify the PID and command path from the exact plist/launchd label. Do not
restart Personal Agent last, enumerate every matching plist, or add historical
instances unless the user requested a full fleet rollout.

## 5. A8C adoption is separate

When A8C was explicitly named, follow `~/a8c-agents/docs/runbook.md`:

```bash
cd "$HOME/a8c-agents"
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
./bin/agents restart
./bin/agents status
./bin/agents versions
```

`restart` already runs the A8C core preflight. Do not duplicate it with
`validate`, `core-preflight`, `preflight`, or `doctor` during routine
dependency adoption. Leave proactive intake stopped. Run `verify-live` only
when the user explicitly requests its real provider-backed capture proof.

## Legacy tracker boundary

Do not invoke or post from `scripts/fleet-green-check.mjs` as part of current
development, release, or deployment work. The implementation remains for
historical compatibility, but it is not an active workflow authority and does
not describe Personal Agent's checkout-backed runtime.

## Completion evidence

For each requested target, report its exact version, source commit or installed
package proof, PID/command provenance, lifecycle status, and bounded error-tail
result. Name any target that failed. Do not call unrelated consumers healthy or
deployed when they were not inspected.
