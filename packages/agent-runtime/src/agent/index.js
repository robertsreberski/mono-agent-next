// Public agent-kernel barrel for runtime hosts. Everything below is
// intentionally re-exported through `@mono-agent/agent-runtime/agent`;
// agent modules not exposed by the package's exports map remain private
// implementation details.

export {
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "./compaction.js";

export {
  buildTranscriptTailSnapshot,
  renderResumeSnapshot,
} from "./transcript.js";

export {
  ALLOWLIST_MODE_ALL,
  ALLOWLIST_MODE_CUSTOM,
  inferAllowlistMode,
  normalizeAllowlistMode,
  normalizeList,
  parseStoredAllowlist,
  resolveAllowlist,
  resolveAllowlistMap,
  storedAllowlistMode,
} from "./allowlists.js";

export {
  APPROVAL_DECISIONS,
  RISK_TIERS,
  createApprovalManager,
  wrapToolsWithApprovalGate,
} from "./approval.js";

export {
  BINARY_BLOAT_TOOLS,
  DEFAULT_TOOL_BLOAT_CONFIG,
  MAX_TOOL_RESULT_BYTES,
} from "./tool-bloat.js";
