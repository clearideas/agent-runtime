import type { EnvironmentReference, ValueSource } from "./config.js";

export interface ValueResolutionContext {
  environment?: Readonly<Record<string, string | undefined>>;
}

const environment = (
  context: ValueResolutionContext,
): Readonly<Record<string, string | undefined>> =>
  context.environment ?? process.env;

export const resolveEnvironmentReference = (
  reference: EnvironmentReference,
  context: ValueResolutionContext = {},
  label = reference.env,
): string => {
  const value = environment(context)[reference.env];
  if (value == null || value.length === 0) {
    throw new Error(`${label} requires environment variable ${reference.env}.`);
  }
  return value;
};

export const resolveValueSource = (
  source: ValueSource,
  context: ValueResolutionContext = {},
  label = "configuration value",
): string =>
  typeof source === "string"
    ? source
    : resolveEnvironmentReference(source, context, label);

export const resolveHeaders = (
  headers: Readonly<Record<string, ValueSource>> | undefined,
  context: ValueResolutionContext = {},
): Record<string, string> | undefined => {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      resolveValueSource(value, context, `Header ${name}`),
    ]),
  );
};
