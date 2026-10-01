import * as z from "zod";
import { baseLogger, getRequestContext } from "@molca/observability";

import { getKeycloakRequestsCounter } from "../../shared/observability/metrics.js";

import type { Logger } from "@molca/utils";
import type { ServiceTokenProvider } from "@molca/mes";
import type { RoleUser } from "./user.js";

// Keycloak's ADMIN API, read-only, for the job dialog's people pickers.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SERVER ASKS, AND WITH WHOSE TOKEN
// ─────────────────────────────────────────────────────────────────────────────
//
//   browser ──cookie──▶ bff ──user token──▶ api ──SERVICE token──▶ Keycloak
//                                            GET /admin/realms/{realm}/roles/{role}/users
//
// The browser never holds a token (AGENTS.md), and an operator's own token would
// not be allowed to list a realm's users anyway. This service's service account
// is — once it has been granted realm-management `view-users` and `view-realm`,
// which is an OPS step, not a code one. Until it has been, every call here is a
// 403, which the service turns into a message that says so rather than an empty
// picker that looks like "nobody holds the role".
//
// Same request discipline as MasterDataClient.request/send: bearer token,
// invalidate-and-retry ONCE on 401/403 (a cached token may have been revoked),
// a hard timeout, and a counter on every outcome. It is a copy rather than a
// shared helper because the two clients disagree about everything past the
// transport — envelopes, pagination, what a 404 means.

// The one page asked for. A role with more members than this is a realm-wide
// role, not a job role, and is reported rather than silently shortened.
const MAX_MEMBERS = 1000;

const memberSchema = z.looseObject({
  id: z.string().check(z.minLength(1)),
  username: z.string(),
  firstName: z.optional(z.string()),
  lastName: z.optional(z.string()),
  enabled: z.optional(z.boolean()),
});

const membersSchema = z.array(memberSchema);

type KeycloakErrorCause = "timeout" | "network_error" | "http_error" | "auth_error" | "parse_error";

class KeycloakError extends Error {
  readonly errorCause: KeycloakErrorCause;
  readonly status?: number;

  constructor(cause: KeycloakErrorCause, message: string, status?: number) {
    super(message);
    this.name = "KeycloakError";
    // Not `cause` — see MasterDataError for why that name is taken.
    this.errorCause = cause;
    this.status = status;
  }
}

type KeycloakUserClientContract = {
  listRoleMembers(roleName: string): Promise<RoleUser[]>;
};

type KeycloakUserClientDeps = {
  keycloakBaseUrl: string;
  keycloakRealm: string;
  keycloakTimeoutMs: number;
  keycloakTokenProvider: ServiceTokenProvider;
  logger?: Logger;
};

// "Ayu Lestari" when Keycloak has a real name, the username otherwise. A picker
// full of `ayu.l` is legible to IT and to nobody on a shop floor.
function displayName(member: z.infer<typeof memberSchema>): string {
  const full = [member.firstName, member.lastName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
  return full === "" ? member.username : full;
}

class KeycloakUserClient implements KeycloakUserClientContract {
  private baseUrl: string;
  private realm: string;
  private timeoutMs: number;
  private tokenProvider: ServiceTokenProvider;
  private fallbackLogger: Logger;

  constructor({
    keycloakBaseUrl,
    keycloakRealm,
    keycloakTimeoutMs,
    keycloakTokenProvider,
    logger,
  }: KeycloakUserClientDeps) {
    this.baseUrl = keycloakBaseUrl.replace(/\/+$/, "");
    this.realm = keycloakRealm;
    this.timeoutMs = keycloakTimeoutMs;
    this.tokenProvider = keycloakTokenProvider;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  async listRoleMembers(roleName: string): Promise<RoleUser[]> {
    const url = new URL(
      `${this.baseUrl}/admin/realms/${encodeURIComponent(this.realm)}` +
        `/roles/${encodeURIComponent(roleName)}/users`,
    );
    url.searchParams.set("first", "0");
    url.searchParams.set("max", String(MAX_MEMBERS));
    url.searchParams.set("briefRepresentation", "true");

    let res = await this.send(url);
    if (res.status === 401 || res.status === 403) {
      this.tokenProvider.invalidate();
      res = await this.send(url);
    }
    if (res.status === 401 || res.status === 403) {
      throw this.fail("auth_error", `keycloak refused the service token`, res.status);
    }
    if (!res.ok) {
      throw this.fail("http_error", `keycloak returned ${res.status}`, res.status);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw this.fail("parse_error", "keycloak response was not JSON");
    }
    const parsed = z.safeParse(membersSchema, json);
    if (!parsed.success) {
      throw this.fail("parse_error", `unexpected keycloak response: ${parsed.error.message}`);
    }

    if (parsed.data.length >= MAX_MEMBERS) {
      this.count("truncated");
      this.logger
        .withMetadata({
          event: "keycloak_role_members_truncated",
          role: roleName,
          max: MAX_MEMBERS,
        })
        .warn("keycloak_role_members_truncated");
    }
    this.count("ok");

    return (
      parsed.data
        // A disabled account cannot log in, so it cannot run a shift either.
        // Absent means enabled — briefRepresentation still carries it, but a
        // missing flag must not empty the picker.
        .filter((member) => member.enabled !== false)
        .map((member) => ({ id: member.id, name: displayName(member) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  private async send(url: URL): Promise<Response> {
    const token = await this.tokenProvider.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw this.fail("timeout", `keycloak timed out after ${this.timeoutMs}ms`);
      }
      throw this.fail("network_error", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(cause: KeycloakErrorCause, message: string, status?: number): KeycloakError {
    this.count(cause);
    return new KeycloakError(cause, message, status);
  }

  private count(outcome: string): void {
    getKeycloakRequestsCounter().add(1, { operation: "listRoleMembers", outcome });
  }
}

export { KeycloakError, KeycloakUserClient, MAX_MEMBERS, displayName };
export type { KeycloakErrorCause, KeycloakUserClientContract, KeycloakUserClientDeps };
