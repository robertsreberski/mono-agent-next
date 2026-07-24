import type {
  ExporterModuleCreateContext,
  ExporterModuleDefinition,
} from "@mono-agent/module-sdk/internal";

import {
  otlpExporterConfigSchema,
  parseOtlpExporterConfig,
  type OtlpExporterConfig,
} from "./config.js";
import {
  OtlpExporter,
  type OtlpExporterOptions,
} from "./exporter.js";
import { OtlpExporterConfigError } from "./config.js";
import { OtlpExporterError, type OtlpExporterErrorCode } from "./errors.js";
import {
  FetchOtlpTransport,
  type OtlpTransport,
  type OtlpTransportRequest,
  type OtlpTransportResponse,
} from "./transport.js";
import { PACKAGE_VERSION } from "./version.js";

export const monoAgentModule = Object.freeze({
  manifest: Object.freeze({
    packageName: "@mono-agent/exporter-otlp",
    packageVersion: PACKAGE_VERSION,
    apiVersion: 1,
    kind: "exporter",
    responsibility: "Exports bounded normalized telemetry batches to an OTLP HTTP endpoint.",
    capabilities: Object.freeze([
      "exporter.otlp",
      "exporter.bounded-queue",
      "exporter.safe-redirects",
      "exporter.phoenix-semantics",
      "exporter.content-pattern-redaction",
    ]),
  }),
  schema: otlpExporterConfigSchema,
  create: (context: ExporterModuleCreateContext<OtlpExporterConfig>) => new OtlpExporter(context.config),
}) satisfies ExporterModuleDefinition<OtlpExporterConfig, OtlpExporter>;

export default monoAgentModule;

export {
  FetchOtlpTransport,
  OtlpExporter,
  OtlpExporterConfigError,
  OtlpExporterError,
  parseOtlpExporterConfig,
};
export type {
  OtlpExporterConfig,
  OtlpExporterErrorCode,
  OtlpExporterOptions,
  OtlpTransport,
  OtlpTransportRequest,
  OtlpTransportResponse,
};
