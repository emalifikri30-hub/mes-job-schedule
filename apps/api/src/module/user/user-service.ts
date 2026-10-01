import { HTTPException } from "hono/http-exception";
import { baseLogger, getRequestContext } from "@molca/observability";

import { StaleCache } from "../../shared/stale-cache.js";
import { getKeycloakCacheCounter } from "../../shared/observability/metrics.js";
import { KeycloakError } from "./keycloak-user-client.js";

import type { Logger } from "@molca/utils";
import type { JobRoleNames } from "../../shared/config/config.js";
import type { JobRole } from "../job/job.js";
import type { KeycloakUserClientContract } from "./keycloak-user-client.js";
import type { RoleUser } from "./user.js";

// Who may be named as a job's Manager, Foreman or AFA.
//
// Each of the three is a Keycloak REALM ROLE, configured by name (JOB_*_ROLE).
// The same list answers two questions, and that is why it lives here rather
// than in the handler:
//
//   GET /users?role=MANAGER          what the picker OFFERS
//   JobService.resolve() on a write  whether a chosen id REALLY holds the role
//
// The second is the one a browser cannot replace. A picker that only lists
// holders is a convenience; without the server-side check, a hand-written body
// can name anybody in the realm — or an id that names nobody — as the manager
// of a job, and it renders exactly like a legitimate one.
//
// FAILURES ARE WORDED FOR THE PERSON WHO HAS TO FIX THEM. The pickers show this
// message verbatim, and each cause has a different owner:
//
//   Keycloak 404   the role name in JOB_*_ROLE does not exist   -> whoever set the env
//   Keycloak 403   the service account lacks view-users        -> the realm admin
//   anything else  Keycloak unreachable, nothing cached         -> on-call
//
// An empty list is NEVER the answer to a failure. "Nobody holds this role" and
// "could not ask" look identical in a picker, and only one of them is true.

const TTL_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 10_000;
// Three keys exist. The cap only bounds a bug.
const MAX_ENTRIES = 10;

type UserServiceContract = {
  listRoleUsers: (role: JobRole) => Promise<RoleUser[]>;
};

type UserServiceDeps = {
  keycloakUserClient: KeycloakUserClientContract;
  jobRoles: JobRoleNames;
  logger?: Logger;
};

function roleFailure(err: unknown, role: JobRole, roleName: string): HTTPException {
  if (err instanceof HTTPException) return err;
  if (err instanceof KeycloakError && err.status === 404) {
    return new HTTPException(502, {
      message: `role "${roleName}" (${role}) not found in the realm`,
      cause: err,
    });
  }
  if (err instanceof KeycloakError && err.errorCause === "auth_error") {
    return new HTTPException(502, {
      message: "service account lacks view-users; cannot list people for this role",
      cause: err,
    });
  }
  const cause = err instanceof KeycloakError ? err.errorCause : "unknown";
  return new HTTPException(503, {
    message: `user directory unavailable (${cause})`,
    cause: err,
  });
}

class UserService implements UserServiceContract {
  private cache = new StaleCache<RoleUser[]>({
    ttlMs: TTL_MS,
    failureBackoffMs: FAILURE_BACKOFF_MS,
    maxEntries: MAX_ENTRIES,
  });
  private client: KeycloakUserClientContract;
  private roles: JobRoleNames;
  private fallbackLogger: Logger;

  constructor({ keycloakUserClient, jobRoles, logger }: UserServiceDeps) {
    this.client = keycloakUserClient;
    this.roles = jobRoles;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  async listRoleUsers(role: JobRole): Promise<RoleUser[]> {
    const roleName = this.roles[role];
    return await this.cache.get({
      // Keyed by the ROLE NAME, not the job role: two job roles configured to the
      // same realm role are one upstream list.
      key: `role-users:${roleName}`,
      fetch: () => this.client.listRoleMembers(roleName),
      onOutcome: (outcome) => getKeycloakCacheCounter().add(1, { outcome }),
      onStale: (value, ageMs) =>
        this.logger
          .withMetadata({
            event: "keycloak_role_members_stale_served",
            role: roleName,
            age_ms: ageMs,
            entries: value.length,
          })
          .warn("keycloak_role_members_stale_served"),
      wrapError: (err) => roleFailure(err, role, roleName),
    });
  }
}

export { UserService, roleFailure };
export type { UserServiceContract, UserServiceDeps };
