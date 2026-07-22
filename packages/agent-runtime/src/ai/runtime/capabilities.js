export const COMMON_CAPABILITIES = {
  streaming: true,
  structured_output: true,
  supports_session_resume: false,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  supports_native_subagents: true,
  supports_fast_mode: false,
};

export const RUNTIME_CAPABILITIES = {
  claude: {
    runtime: "sdk",
    ...COMMON_CAPABILITIES,
    // The Claude Agent SDK persists sessions on disk; the bridge resumes
    // them via queryOptions.resume when options.sessionId is supplied.
    supports_session_resume: true,
  },
  pi: {
    runtime: "pi-agent",
    ...COMMON_CAPABILITIES,
    // The pi bridge keeps a pi-agent-core Session transcript per provider
    // session id and seeds Agent initialState.messages on resume.
    supports_session_resume: true,
    // The pi-native bridge does not (yet) wire native subagents / an AskAgent
    // tool, so advertise no support rather than letting callers expect it.
    supports_native_subagents: false,
  },
  codex: {
    runtime: "cli",
    ...COMMON_CAPABILITIES,
    // The codex-app bridge keeps the app-server subprocess + thread alive
    // when options.sessionKeepAlive is set; resumed turns reuse the thread.
    supports_session_resume: true,
    supports_fast_mode: true,
  },
  opencode: {
    runtime: "cli",
    ...COMMON_CAPABILITIES,
    structured_output: false,
    supports_session_resume: false,
    supports_mcp: false,
    supports_skills: false,
    supports_live_input: false,
    supports_native_subagents: false,
  },
};

export function runtimeCapabilities(sdkOrModel) {
  if (!sdkOrModel) throw new Error("runtimeCapabilities requires a model reference or sdk kind");
  const sdk = typeof sdkOrModel === "string" ? sdkOrModel : sdkOrModel?.sdk;
  if (!sdk) throw new Error("runtimeCapabilities: unrecognized argument");
  const caps = RUNTIME_CAPABILITIES[sdk];
  if (!caps) throw new Error(`unknown provider sdk: ${sdk}`);
  return { kind: sdk, ...caps };
}
