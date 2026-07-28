# Personal successor blueprint

This non-publishable fixture describes the clean-room Personal Agent successor.
It deliberately keeps the public `personal` scaffold unchanged and adds only
the separately installed operator, TUI, web, documentation MCP, and macOS
service products.

The blueprint is inert. Its listeners are loopback-only, use ephemeral ports,
and no service is installed by verification. The macOS service file is a
template whose `__PROJECT_ROOT__` tokens are rendered to one canonical absolute
consumer root before validation.

`pnpm run verify:personal-successor` proves the exact packed Personal scaffold,
the real operator/TUI/web products, and the service lifecycle with a fake
`launchctl` and temporary LaunchAgents directory. The repository browser lane
is the companion real-browser proof and runs only on Node 22 in CI.

An adopted private consumer records the reviewed source commit and SHA-256 for
every vendored tarball in `artifact-manifest.json`. Its package dependencies
must use project-relative `file:vendor/*.tgz` references, its lockfile must be
frozen, and the repository must have no remote.
