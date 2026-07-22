# Security policy

## Reporting a vulnerability

Do not open a public issue for an exploitable vulnerability or include live credentials in a report. Use GitHub's private security-advisory flow for this repository. Include the affected package/version, configuration, impact, and the smallest safe reproduction you can provide.

## Trust boundary

mono-agent is local-first and single-owner by default. It can execute model-selected tools, read configured context, retain conversations and run artifacts, and send through enabled channels. Treat anyone who can operate an exposed endpoint as having the authority of that agent.

Network-facing defaults and guards differ by surface:

| Surface | Default boundary |
| --- | --- |
| TUI/operator endpoint | Ephemeral loopback listener; non-loopback requires explicit opt-in. |
| Webhook and OpenAI-compatible API | Loopback by default; non-loopback requires explicit opt-in and a bearer key. |
| A2A provider | Loopback by default; public use should add bearer auth and TLS at a reverse proxy. |
| Always-on web console | Binds `0.0.0.0:5050` by default and intentionally has no application login. |

The web console's unauthenticated LAN/tailnet behavior is an explicit v1 product decision. It is an owner-equivalent operator surface: anyone who can reach it can read retained conversations, upload files, cancel turns, and instruct discovered agents. Use it only on a trusted LAN or tailnet, or start it with `mono-agent web start --loopback`. Host and Origin checks reduce browser request confusion but are not authentication, and plain LAN HTTP is not encrypted. Do not publish the port directly to the internet.

See [`docs/reference/setup-security.md`](./docs/reference/setup-security.md) for managed-runtime, secret-persistence, sandbox, and readiness guarantees.

## Secret handling

- Keep provider and channel credentials in an owner-only `.env` or provider-native auth store, never committed JSON.
- Treat artifact redaction as defense in depth. Free-form model, user, and tool text may still contain sensitive data.
- Rotate a credential before removing a leaked copy. Deleting a file does not revoke the credential or erase Git history/backups.
- Do not paste secrets into issues, logs, screenshots, or model prompts used for debugging.

## Local cleanup checklist

Repository maintenance does not authorize deleting an operator's ignored credentials or run history. The owner should perform this checklist deliberately for each clone and agent folder:

1. Stop the affected agent and web service so no process keeps writing the files.
2. Inventory ignored state with `git status --ignored --short` and confirm `.env` is ignored with `git check-ignore -v .env`.
3. Rotate provider, channel, and API credentials at their issuer. Update the secure local auth store only after rotation.
4. Remove only the explicitly reviewed local `.env`, auth, artifact, trace, log, upload, and temporary files. Preserve any run evidence still needed for incident review.
5. Check whether a secret ever entered Git with `git log --all -- .env` and a targeted `git rev-list --objects --all` search. If it did, coordinate history rewriting with every clone after revocation; ordinary file deletion is insufficient.
6. Restart, run `mono-agent validate`, and smoke-test the exact enabled surface with the replacement credential.

Never automate this checklist across a home directory or repository root with a broad recursive delete.
