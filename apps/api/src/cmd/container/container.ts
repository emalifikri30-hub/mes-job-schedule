import {
  type AwilixContainer,
  createContainer as newContainer,
  InjectionMode,
  asValue,
  asFunction,
} from "awilix";

import type { Probe } from "../../module/health/health-service.js";
import type { AppConfig, JobRoleNames, OperatorRoles } from "../../shared/config/config.js";
import type { PostgresDB } from "../../shared/database/postgres.js";

import { baseLogger } from "@molca/observability";
import { registerInfra } from "../../shared/infra-module.js";
import { registerHealth } from "../../module/health/health-module.js";
import { registerMasterData } from "../../module/master-data/master-data-module.js";
import { registerJob } from "../../module/job/job-module.js";
import { registerUser } from "../../module/user/user-module.js";

import type { MasterDataClientContract } from "@molca/contract-client";
import type { TimeZoneResolverContract } from "../../module/master-data/time-zone-resolver.js";
import type { MasterDataServiceContract } from "../../module/master-data/master-data-service.js";
import type { ActivityReader, JobReader, JobWriter } from "../../module/job/job-repository.js";
import type { JobServiceContract } from "../../module/job/job-service.js";
import type { KeycloakUserClientContract } from "../../module/user/keycloak-user-client.js";
import type { UserServiceContract } from "../../module/user/user-service.js";
import type { AuthMiddleware, ServiceTokenProvider } from "@molca/mes";

// Awilix runs in PROXY mode with `strict: true`, so every name a constructor
// destructures must appear here AND be registered — an omission throws at
// resolve time, not at boot.
type Cradle = {
  // ONE database. The template this was taken from carried a Gold and a Silver
  // tier; there is no telemetry here, so there is no second pool and no second
  // readiness probe.
  jobDb: PostgresDB;
  authMw: AuthMiddleware;
  operatorRoles: OperatorRoles;
  serviceTokenProvider: ServiceTokenProvider;
  keycloakTokenProvider: ServiceTokenProvider;
  keycloakBaseUrl: string;
  keycloakRealm: string;
  keycloakTimeoutMs: number;
  jobRoles: JobRoleNames;
  masterDataBaseUrl: string;
  masterDataTimeoutMs: number;
  keycloakProbe: Probe;
  jobScheduleProbe: Probe;
  masterDataClient: MasterDataClientContract;
  masterDataService: MasterDataServiceContract;
  timeZoneResolver: TimeZoneResolverContract;
  keycloakUserClient: KeycloakUserClientContract;
  userService: UserServiceContract;
  // One registration behind every interface — see job-module.ts for why these
  // tables get no reader/writer split.
  jobRepository: JobReader & JobWriter & ActivityReader;
  jobService: JobServiceContract;
};

function createContainer(config: AppConfig): AwilixContainer<Cradle> {
  const container: AwilixContainer<Cradle> = newContainer<Cradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  container.register({
    region: asValue(config.region),
    logger: asFunction(() => baseLogger).singleton(),
  });
  registerInfra(container, config);
  registerHealth(container, config);
  registerMasterData(container);
  registerUser(container);
  registerJob(container);

  return container;
}

export { createContainer };
export type { Cradle };
