import { defineExporterModule } from "@mono-agent/module-sdk/internal";

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

export const monoAgentModule = defineExporterModule({
  manifest: {
    packageName: "@mono-agent/exporter-otlp",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "exporter",
    responsibility: "Exports bounded normalized telemetry batches to an OTLP HTTP endpoint.",
    capabilities: ["exporter.otlp", "exporter.bounded-queue", "exporter.safe-redirects"],
  },
  schema: otlpExporterConfigSchema,
  create: (context) => new OtlpExporter(context.config),
});

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
