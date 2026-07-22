/** Per-call hints for a completion. `label` tags the ritual (e.g. "capture:extract") so a recording host can group/name the run. */
export interface LlmCompleteOptions {
  readonly label?: string;
  readonly abortSignal?: AbortSignal;
}

/** Minimal injected LLM completion surface. Implementations adapt the host runtime (P4); tests use a fake. */
export interface LlmComplete {
  readonly id: string;
  /**
   * Returns the model's text completion for the prompt. The optional `opts.label`
   * is an advisory ritual tag; implementations that don't record may ignore it.
   */
  complete(prompt: string, opts?: LlmCompleteOptions): Promise<string>;
}
