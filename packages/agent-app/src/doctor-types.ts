export type ValidationStatus = "ok" | "waiting" | "disabled" | "error";

export interface ValidationSection {
  readonly id: string;
  readonly label: string;
  readonly status: ValidationStatus;
  readonly details: readonly string[];
}

export interface ValidationReport {
  readonly sections: readonly ValidationSection[];
  /** True when no section reports an error. */
  readonly structurallyValid: boolean;
  /** True only when every configured capability is live; disabled sections are fine. */
  readonly operationallyReady: boolean;
  /** Compatibility alias for structurallyValid; prefer the explicit fields above. */
  readonly ok: boolean;
}
