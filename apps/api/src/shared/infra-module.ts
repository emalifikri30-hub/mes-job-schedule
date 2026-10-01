import { asFunction, asValue, type AwilixContainer } from "awilix";
import {
  createAuthMiddleware,
  createKeycloakJwks,
  bearerToken,
  createServiceTokenProvider,
} from "@molca/mes";
import type { AppConfig, DbTierConfig } from "./config/config.js";
import { createPostgresDb } from "./database/postgres.js";

// The one pool this service opens.
function tierPool(tier: DbTierConfig, applicationName: string, readOnly: boolean) {
  return createPostgresDb({
    connectionString: tier.url,
    max: tier.maxConnection,
    connectionTimeoutMillis: tier.connectTimeoutMs,
    idleTimeoutMillis: tier.idleTimeoutMs,
    debug: tier.logger,
    applicationName,
    readOnly,
  });
}

function registerInfra(container: AwilixContainer, config: AppConfig) {
  container.register({
    // The `job_schedule` schema. READ-WRITE, and unlike the template this was
    // taken from, THIS SERVICE IS THE ONLY WRITER: there is no pipeline filling
    // these tables, so every row here was entered by a named operator through
    // this API. That is why `created_by_id` is NOT NULL and why the write path
    // has no bulk mode.
    //
    // It connects to the same Postgres INSTANCE as mes-oee-monitor's `oee`
    // schema but owns only its own schema. See scripts/migrate.mjs for what that
    // sharing cost the migration ledger.
    jobDb: asFunction(() => tierPool(config.database.job, `${config.applicationAlias}-job`, false))
      .singleton()
      .disposer((conn) => conn.end()),
    authMw: asFunction(() =>
      createAuthMiddleware({
        issuer: config.oidc.baseUri,
        getKey: createKeycloakJwks(config.oidc.baseUri),
        getToken: bearerToken(),
        // Both undefined unless an operator sets AUTH_AUDIENCE / AUTH_ALLOWED_AZP,
        // in which case the middleware behaves exactly as it did before these
        // existed. Enabling `audience` needs a Keycloak audience mapper first —
        // Keycloak emits `aud: ["account"]` by default, so turning it on against
        // an unconfigured realm 401s every caller.
        audience: config.auth.audience,
        allowedAzp: config.auth.allowedAzp,
      }),
    ).singleton(),
    // MUST be a singleton: the token cache and the single-flight guard live on
    // the instance, so a scoped registration would mint a token per request and
    // defeat both.
    serviceTokenProvider: asFunction(() =>
      createServiceTokenProvider({
        tokenUri: config.oidc.tokenUri,
        clientId: config.oidc.clientId,
        clientSecret: config.oidc.clientSecret,
        audience: config.masterData.audience,
      }),
    ).singleton(),
    // A SECOND provider, same client, for Keycloak's admin API (the job people
    // pickers). Separate because the one above is minted FOR mes-master-data —
    // `audience` names it — and one cached token serving two audiences is a
    // token that is right for at most one of them. A singleton for the same
    // cache-and-single-flight reason.
    keycloakTokenProvider: asFunction(() =>
      createServiceTokenProvider({
        tokenUri: config.oidc.tokenUri,
        clientId: config.oidc.clientId,
        clientSecret: config.oidc.clientSecret,
      }),
    ).singleton(),
    // Primitives the master-data client destructures by name. Registered as
    // values rather than read from config inside the client, so the client stays
    // testable without constructing an AppConfig.
    // TODOS.md §34's gate, and it ships DARK: every field is undefined unless an
    // operator sets APPROVE_ROLE / REOPEN_ROLE / EDIT_DOWNTIME_ROLE, in which
    // case requireRole checks nothing and the three mutations behave exactly as
    // they did before the gate existed.
    //
    // The rollout trap is sharper than AUTH_AUDIENCE's above. A wrong audience
    // 401s callers, which looks like an auth problem and gets diagnosed as one; a
    // role name Keycloak does not emit 403s only the three write paths, so reads
    // keep working and the screen looks healthy right up to the moment somebody
    // tries to sign a shift off. Set one, have a real operator exercise that one
    // route, and watch operator_authorization_denials_total before setting the
    // next.
    operatorRoles: asValue(config.auth.roles),
    masterDataBaseUrl: asValue(config.masterData.baseUrl),
    // The admin API lives at the Keycloak HOST, not under the realm's issuer URI,
    // and names the realm in its path. KEYCLOAK_REALMS may be a comma list for
    // the health probe; the users live in the first.
    keycloakBaseUrl: asValue(config.oidc.host),
    keycloakRealm: asValue(config.keycloak.realms.split(",")[0]!.trim()),
    keycloakTimeoutMs: asValue(config.keycloak.timeout),
    jobRoles: asValue(config.jobRoles),
    masterDataTimeoutMs: asValue(config.masterData.timeoutMs),
  });
}

export { registerInfra };
