export class ServiceMacosDriftError extends Error {
  readonly code = "service_macos_plan_drift";
  constructor(message: string) {
    super(message);
    this.name = "ServiceMacosDriftError";
  }
}
export class ServiceMacosMutationDisabledError extends Error {
  readonly code = "service_macos_mutation_disabled";
  constructor() {
    super("Service mutation is disabled; pass allowMutation: true (CLI: --allow-mutation) explicitly.");
    this.name = "ServiceMacosMutationDisabledError";
  }
}
