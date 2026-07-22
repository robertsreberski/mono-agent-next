import { passthroughSandbox } from "../sandbox-seam.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

/**
 * @param {{query: string, limit?: number}} params
 * @param {{sandboxPolicy?: any, ctx?: any}} [options]
 */
export async function webSearchToolImpl({ query, limit = 5 }, { sandboxPolicy, ctx } = {}) {
  const max = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  if (!sandbox.networkAllowsUrl(resolveSandboxPolicy(resolvedCtx, sandboxPolicy), url)) return "Error: Network access denied by sandbox policy.";
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 AgentRuntime/0.1" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return `Search failed: HTTP ${resp.status}`;
  const html = await resp.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    results.push(`${m[2].replace(/<[^>]+>/g, "").trim()}\n${m[1]}\n${m[3].replace(/<[^>]+>/g, "").trim()}`);
  }
  return results.length ? results.join("\n\n") : "No results.";
}
