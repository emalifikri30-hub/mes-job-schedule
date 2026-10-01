import { asFunction, type AwilixContainer } from "awilix";

import type { AppConfig } from "../../shared/config/config.js";

import { KeycloakProbe, PostgresProbe } from "./health-service.js";

// TWO PROBES, NOT THE TEMPLATE'S THREE.
//
// Keycloak gates readiness because every route on this service is authenticated
// — an unreachable IdP means nothing here can serve. The job_schedule database
// gates it because the calendar has nothing to read without it.
//
// There is no Silver probe. The template's api read a shared TimescaleDB and
// deliberately failed readiness when it was down, on the grounds that "a monitor
// that cannot read telemetry is not serving its purpose". This service reads no
// telemetry, so taking it out of rotation for a Timescale outage would be an
// outage it invented for itself.
function registerHealth(container: AwilixContainer, config: AppConfig) {
  container.register({
    keycloakProbe: asFunction(
      () => new KeycloakProbe({ oidcBase: config.oidc.baseUri }),
    ).singleton(),
    jobScheduleProbe: asFunction(
      ({ jobDb }) => new PostgresProbe({ db: jobDb, label: "job" }),
    ).singleton(),
  });
}

export { registerHealth };
