/**
 * Authentication: API keys issued by the operator, and an optional host
 * hook for other credentials. The result is a principal whose id scopes
 * conversations and whose models limit what it may call.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import type { ApiKeyConfig } from "./config.js";
import { ServerError } from "./errors.js";

/** An authenticated caller. */
export interface Principal {
  /** Stable id used in logs, metrics, and the conversation scope. Never the credential. */
  id: string;
  /** Served model names the caller may use, or "*" for all. */
  models: "*" | ReadonlySet<string>;
  /** Overrides the derived conversation scope (`key:<id>`). */
  scope?: string;
  maxConcurrentRuns?: number;
  maxTotalTokensPerRequest?: number;
}

/** What an `authenticate` hook receives. */
export interface AuthenticationRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** A principal returned by a host `authenticate` hook. */
export interface HostPrincipal {
  id: string;
  models?: "*" | string[];
  scope?: string;
  maxConcurrentRuns?: number;
  maxTotalTokensPerRequest?: number;
}

/**
 * Host authentication hook, exported as `authenticate` by the runtime
 * module. Return a principal to accept the request, `undefined` to decline
 * (the server then reports the request as unauthenticated), or throw to
 * reject it.
 */
export type AuthenticateHook = (
  request: AuthenticationRequest,
) => HostPrincipal | undefined | Promise<HostPrincipal | undefined>;

interface ResolvedKey {
  digest: Buffer;
  principal: Principal;
}

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

const principalFromKey = (key: ApiKeyConfig): Principal => ({
  id: key.id,
  models: key.models === "*" ? "*" : new Set(key.models),
  ...(key.maxConcurrentRuns != null
    ? { maxConcurrentRuns: key.maxConcurrentRuns }
    : {}),
  ...(key.maxTotalTokensPerRequest != null
    ? { maxTotalTokensPerRequest: key.maxTotalTokensPerRequest }
    : {}),
});

export const ANONYMOUS_PRINCIPAL: Principal = { id: "anonymous", models: "*" };

export interface AuthenticatorOptions {
  keys: readonly ApiKeyConfig[];
  environment?: Readonly<Record<string, string | undefined>>;
  hook?: AuthenticateHook;
  /** Accept requests without credentials when no key or hook is configured. */
  allowAnonymous: boolean;
}

export class Authenticator {
  readonly #keys: ResolvedKey[];
  readonly #hook: AuthenticateHook | undefined;
  readonly #allowAnonymous: boolean;

  constructor(options: AuthenticatorOptions) {
    const environment = options.environment ?? process.env;
    this.#keys = options.keys.map((key) => {
      if ("env" in key.key) {
        const value = environment[key.key.env];
        if (!value) {
          throw new Error(
            `API key ${key.id} reads environment variable ${key.key.env}, which is not set.`,
          );
        }
        return { digest: sha256(value), principal: principalFromKey(key) };
      }
      return {
        digest: Buffer.from(key.key.sha256, "hex"),
        principal: principalFromKey(key),
      };
    });
    this.#hook = options.hook;
    this.#allowAnonymous = options.allowAnonymous;
  }

  /** True when requests are accepted without a credential. */
  get anonymous(): boolean {
    return this.#allowAnonymous && this.#keys.length === 0 && !this.#hook;
  }

  async authenticate(request: AuthenticationRequest): Promise<Principal> {
    if (this.anonymous) return ANONYMOUS_PRINCIPAL;
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = value ? /^Bearer\s+(.+)$/iu.exec(value.trim()) : null;
    const presented = match?.[1]?.trim();
    if (presented) {
      const digest = sha256(presented);
      let found: Principal | undefined;
      // Compare against every key so timing does not reveal which matched.
      for (const key of this.#keys) {
        if (timingSafeEqual(digest, key.digest)) found ??= key.principal;
      }
      if (found) return found;
    }
    if (this.#hook) {
      const principal = await this.#hook(request);
      if (principal) {
        if (!principal.id || typeof principal.id !== "string")
          throw new Error("authenticate must return a principal with an id.");
        return {
          id: principal.id,
          models:
            principal.models === undefined || principal.models === "*"
              ? "*"
              : new Set(principal.models),
          ...(principal.scope ? { scope: principal.scope } : {}),
          ...(principal.maxConcurrentRuns != null
            ? { maxConcurrentRuns: principal.maxConcurrentRuns }
            : {}),
          ...(principal.maxTotalTokensPerRequest != null
            ? { maxTotalTokensPerRequest: principal.maxTotalTokensPerRequest }
            : {}),
        };
      }
    }
    throw new ServerError(
      401,
      "invalid_api_key",
      presented
        ? "Incorrect API key provided."
        : "Missing API key. Send it as an Authorization: Bearer header.",
      { type: "authentication_error" },
    );
  }
}

export const principalCanUse = (principal: Principal, model: string): boolean =>
  principal.models === "*" || principal.models.has(model);
