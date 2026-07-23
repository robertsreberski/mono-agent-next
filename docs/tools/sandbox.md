---
title: "Sandbox"
description: "Keep sandboxing explicitly off or select the integrity-pinned fail-closed SRT implementation."
sidebar:
  order: 3
---

The fixed policy envelope makes sandbox selection visible:

```json
{
  "policy": {
    "sandbox": { "mode": "off" }
  }
}
```

To use the first-party implementation, install
`@mono-agent/sandbox-srt` directly and select its exact executable and settings:

```json
{
  "policy": {
    "sandbox": {
      "$use": "@mono-agent/sandbox-srt",
      "executable": {
        "path": "/absolute/private/path/to/srt",
        "sha256": "<64-lowercase-hex-characters>"
      },
      "settings": {
        "path": "/absolute/private/path/to/settings.json",
        "sha256": "<64-lowercase-hex-characters>"
      }
    }
  }
}
```

Both files must be canonical, owner-controlled, regular, single-link files.
The settings file is `0600`; the executable must be user-executable without
set-ID or group/world-write bits. The module validates device/inode identity,
mode, size, and SHA-256 content before selection and around every invocation.

Commands use an exact argument vector with `shell: false`, an empty environment
plus explicit allowlists, absolute working directories, bounded input/output,
timeouts, cancellation, process-group termination, and idempotent stop.

Missing SRT, mismatched digests, path swaps, unsafe modes, symlinks, hard links,
overflow, timeout, or integrity drift fail closed. The package does not search
`PATH`, install SRT, generate policy, project sandbox claims onto a
provider-native runtime, or fall back to unsafe host execution.

Use the exact schema and public API linked from the
[package directory](/reference/packages/).
