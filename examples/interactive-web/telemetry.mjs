import { OpenTelemetryEventSink } from "@clearideas/agent-runtime-telemetry-otel";

const enabled = (value) =>
  ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());

export const createExampleTelemetry = async (overrides = {}) => {
  if (overrides.sink) {
    return {
      sink: overrides.sink,
      exporter: overrides.exporter ?? "test",
      shutdown: async () => overrides.shutdown?.(),
    };
  }

  const consoleExport =
    overrides.consoleExport ?? enabled(process.env.AGENT_EXAMPLE_OTEL_CONSOLE);
  const configuredExporter = process.env.OTEL_TRACES_EXPORTER?.toLowerCase();
  const otlpExport =
    overrides.otlpExport ??
    (configuredExporter === "otlp" ||
      (configuredExporter == null &&
        Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)));

  let sdk;
  let exporter = "none";
  if (consoleExport || otlpExport) {
    const [{ NodeSDK }, { ConsoleSpanExporter }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/sdk-trace-node"),
    ]);
    sdk = new NodeSDK({
      serviceName:
        process.env.OTEL_SERVICE_NAME ?? "agent-runtime-interactive-example",
      ...(consoleExport ? { traceExporter: new ConsoleSpanExporter() } : {}),
    });
    sdk.start();
    exporter = consoleExport ? "console" : "otlp";
  }

  const sink = new OpenTelemetryEventSink();
  return {
    sink,
    exporter,
    shutdown: async () => {
      sink.shutdown();
      await sdk?.shutdown();
    },
  };
};
