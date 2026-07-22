import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { readSettingsJson } from "@mono-agent/agent-contracts";

import type { MonoAgentAppConfigInput } from "./app-config.js";

/** What marks a channel as "the operator expressed intent" for the lazy-load gate. */
export interface ChannelGateSpec {
  /** Top-level key of the channel's section in mono-agent.config.json. */
  readonly jsonKey: string;
  /** Env prefix: any set `MONO_AGENT_<X>_*` var marks the channel configured. */
  readonly envPrefix: string;
  /** Folder (relative to cwd) whose existence marks the channel configured (cron/, webhook/). */
  readonly dir?: string;
}

/**
 * True when the operator expressed ANY intent for the channel: its JSON section
 * exists (even with `enabled: false` — the real loader must still parse it so a
 * malformed disabled section keeps erroring exactly as before), any env var
 * with the channel's prefix is set, or its jobs/endpoints folder exists.
 *
 * False is the lazy-load fast path: the adapter module is never imported and
 * the driver answers with the loader's own empty-input output (drift-guarded
 * by tests) — so a webhook-only agent never loads the chat SDKs.
 */
export async function isChannelConfigured(
  input: MonoAgentAppConfigInput,
  spec: ChannelGateSpec,
): Promise<boolean> {
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined && key.startsWith(spec.envPrefix)) {
      return true;
    }
  }
  const { json } = await readSettingsJson(input.configPath);
  if ((json as Record<string, unknown>)[spec.jsonKey] !== undefined) {
    return true;
  }
  if (spec.dir !== undefined) {
    try {
      await access(resolve(input.cwd, spec.dir));
      return true;
    } catch {
      // folder absent → no intent from this signal
    }
  }
  return false;
}
