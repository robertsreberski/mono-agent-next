---
name: ops-log-hygiene
description: Check bounded logs for explicitly restarted services, or run a full log-health audit when requested or when symptoms justify it. Use for crash-loop diagnosis, oversized logs, restart churn, or an explicit live-fleet log audit.
---

# Ops log hygiene

Routine restart proof is target-scoped. A full-fleet log/provenance audit is a
separate diagnostic operation and is not automatic after every restart.

## Choose the mode

### Bounded post-restart check

Use after restarting named services:

1. Resolve each exact log path from its plist.
2. Confirm the current PID remains stable across the short check.
3. Read only the last 20–30 stdout/error lines.
4. Count repeated terminal errors in that bounded tail.

```bash
plutil -p "$HOME/Library/LaunchAgents/<label>.plist" | grep -E 'Standard(Out|Error)Path'
tail -n 25 <resolved-error-log>
tail -n 25 <resolved-error-log> | sort | uniq -c | sort -rn | head -1
```

Repeated fatal lines, a disappearing PID, or a non-zero launchd exit is a failed
restart. Report it and diagnose that service; do not widen automatically to the
whole fleet.

### Full audit

Run only when the user asks for fleet/log health, a bounded check finds a
symptom, log-maintenance code changed, or there is evidence of disk growth,
crash loops, or channel churn. The audit may inspect every named in-scope
service for caps, retained generations, launchd state, wrapper provenance, and a
bounded recent churn window.

## Provenance rules

Different consumers intentionally use different runtime sources:

- Personal Agent: its CLI wrappers and launchd command should resolve into the
  clean local mono-agent `main` checkout. This is expected and healthy.
- Other managed `com.mono-agent.*` instances: wrappers should agree with the
  copied runtime referenced by their plist.
- A8C services: use the installed package graph and `./bin/agents versions`
  from `~/a8c-agents`; do not compare them to Personal Agent's checkout path.

A mismatch within one consumer is a finding. A difference between these
consumer classes is not.

## Log size audit

Managed mono-agent logs normally live under `~/.mono-agent/logs`; A8C logs
normally live under `~/Library/Logs/a8c-agents`. Resolve paths from plists
before trusting either convention.

For a full mono-agent audit, check active files and the three managed retained
generations against the 5 MiB per-file cap:

```bash
if [ -d "$HOME/.mono-agent/logs" ]; then
  find "$HOME/.mono-agent/logs" -maxdepth 1 -type f \
    \( -name '*.log' -o -name '*.log.[123]' \) \
    -exec sh -c '
      for file do
        bytes=$(stat -f%z "$file")
        [ "$bytes" -gt 5242880 ] && echo "OVER CAP: $file ($bytes bytes)"
      done
    ' sh {} +
fi
```

An active file may briefly exceed the cap between maintenance passes. A retained
file over cap, a missing helper, or a repeatedly oversized active file is an
operations failure. Inspect the maintenance job; never truncate a live writer by
hand.

## Channel churn

Only when channel health is in scope, count a bounded recent window rather than
scanning months of logs:

```bash
grep "$(date -u -v-1H +%Y-%m-%dT%H)" <resolved-log> | grep -c "channel degraded"
grep "$(date -u -v-1H +%Y-%m-%dT%H)" <resolved-log> | grep -c "scheduling restart"
```

Compare the rate with that service's recent baseline and report the exact
window. Do not treat one self-healed timeout as a fleet incident.

## Report format

For a bounded check, report only the named target, PID stability, tail size, and
top repeated error count. For a full audit, add file sizes versus cap, correct
consumer-specific provenance, and bounded churn counts. Sanitize tokens and
never paste raw private log payloads.
