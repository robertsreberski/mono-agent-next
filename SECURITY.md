# Security policy

## Reporting a vulnerability

Do not open a public issue for an exploitable vulnerability or include live
credentials in a report. Use a private contact method listed on the
[maintainer's GitHub profile](https://github.com/robertsreberski). Include the
affected package/version, configuration, impact, and the smallest safe
reproduction you can provide.

## Trust boundary

`mono-agent` is local-first and single-owner by default. It can execute model-selected tools, read configured context, retain conversations and run artifacts, and send through enabled channels. Treat anyone who can operate an exposed endpoint as having the authority of that agent.

Network-facing defaults and guards differ by surface:

| Surface | Default boundary |
| --- | --- |
| TUI/operator endpoint | Authenticated loopback listener; non-loopback is rejected. |
| Webhook and OpenAI-compatible API | Loopback by default; non-loopback requires explicit opt-in and a bearer key. |
| Telegram and Slack | Exact configured allowlists plus provider-native credentials. |
| Standalone web product | Authenticated `127.0.0.1:5050` by default; non-loopback plaintext requires explicit risk opt-in and a stronger bearer. |

The web product is an owner-equivalent operator surface. Anyone with both
network reachability and its bearer can read retained conversations, cancel
turns, and instruct discovered agents. Host and Origin checks reduce browser
request confusion but are not authentication, and plain LAN HTTP is not
encrypted. Prefer loopback behind a correctly configured HTTPS reverse proxy
or Tailscale Serve; do not publish the direct port to the internet.

See [`docs/reference/setup-security.md`](./docs/reference/setup-security.md) for runtime authentication, secret-persistence, sandbox, and readiness guarantees.

## Secret handling

- Keep provider and channel credentials in owner-private external environment injection or a provider-native auth store, never committed JSON.
- Treat artifact redaction as defense in depth. Free-form model, user, and tool text may still contain sensitive data.
- Rotate a credential before removing a leaked copy. Deleting a file does not revoke the credential or erase Git history/backups.
- Do not paste secrets into issues, logs, screenshots, or model prompts used for debugging.

## Local cleanup checklist

Repository maintenance does not authorize deleting an operator's ignored credentials or run history. The owner should perform this checklist deliberately for each clone and agent folder:

1. Stop the affected agent and independently managed web product so no process keeps writing the files.
2. Inventory ignored state with `git status --ignored --short` and confirm `.env` is ignored with `git check-ignore -v .env`.
3. Rotate provider, channel, and API credentials at their issuer. Update the secure local auth store only after rotation.
4. Remove only the explicitly reviewed local `.env`, auth, artifact, trace, log, upload, and temporary files. Preserve any run evidence still needed for incident review.
5. Check whether a secret ever entered Git with `git log --all -- .env` and a targeted `git rev-list --objects --all` search. If it did, coordinate history rewriting with every clone after revocation; ordinary file deletion is insufficient.
6. From the installed agent folder, restart only the explicitly intended
   target, run the project-local CLI with
   `node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js validate --config <file>`,
   and smoke-test the exact enabled surface with the replacement credential.

Never automate this checklist across a home directory or repository root with a broad recursive delete.
