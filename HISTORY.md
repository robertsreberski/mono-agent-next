# Project history

This public repository was bootstrapped on 2026-07-22 from the Git-tracked
tree of the original private `robertsreberski/mono-agent` repository at commit
`79140866712145cb5cc3e2b742445db4fb1b4df8`.

The deterministic `git archive` of that source tree has SHA-256 digest
`51536e10319b372b3a797992ac9b89a60be18b08d3723d18fe8353683b4f0f20`.
During bootstrap review, organization-specific links in one Markdown test and
a captured observability transcript fixture were replaced with behaviorally
equivalent synthetic data. Two source-only consumer contract configs were then
added as sanitized fixtures, and a temporary successor deployment guard was
added and mechanically enforced. These review changes belong to the bootstrap
PR rather than the archived source tree; the public commits retain their exact
sequencing and provenance.
The earlier private Git history is retained in a private archive because it
contains environment-specific operational records that are not part of the
open-source distribution. It is intentionally not grafted into this public
history.

Published `@mono-agent/*` and `create-mono-agent` releases before this import
remain available from npm. Public source and release provenance continue from
this audited seed.
