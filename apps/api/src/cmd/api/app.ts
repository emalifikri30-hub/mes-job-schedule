import { startOtel } from "@molca/observability";

// Start the OTel SDK before anything else loads so instrumentation can patch
// modules. In prod this is a no-op (already started by --import instrumentation.mjs).
// There is no database instrumentation to register: postgres.js cannot be
// auto-patched, so the repositories emit their spans through the `traced()`
// helper in shared/database/postgres.ts instead.
startOtel();

import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { httpInstrumentationMiddleware } from "@hono/otel";

import type { ContentfulStatusCode } from "hono/utils/http-status";

import { createContainer } from "../container/container.js";
import { loadConfig } from "../../shared/config/config.js";
import { createHealthHandler } from "../../module/health/health-handler.js";
import { createMasterDataHandler } from "../../module/master-data/master-data-handler.js";
import { createJobHandler } from "../../module/job/job-handler.js";
import { createUserHandler } from "../../module/user/user-handler.js";
import { mapDomainError } from "@molca/helper";
import { observability, baseLogger, getRequestContext } from "@molca/observability";
import { serializeError } from "@molca/utils";
import { WebResponse } from "@molca/network";

const config = loadConfig();
const container = createContainer(config);

const app = new Hono();

app.use("*", httpInstrumentationMiddleware());
app.use("*", observability());
app.use(
  "*",
  cors({
    origin: config.cors.allowedOrigins,
  }),
);

app.route(
  "/health",
  createHealthHandler({
    keycloakProbe: container.resolve("keycloakProbe"),
    jobScheduleProbe: container.resolve("jobScheduleProbe"),
  }),
);

const api = new Hono().basePath("/api/v1");

// JOBS — this service's own resource, and the only one it owns.
//
// Plural and top-level rather than nested under a line or a machine: a job's plan
// covers a SET of lines and machines, so there is no single parent to nest it
// under. The scope arrives as a query filter instead, which is the same call
// mes-oee-monitor makes for `/downtimes` and for the same reason.
api.route(
  "/jobs",
  createJobHandler({
    authMw: container.resolve("authMw"),
    jobService: container.resolve("jobService"),
  }),
);

// The members of the three job realm roles, for the people pickers. Keycloak's,
// not this service's — namespaced by what they are rather than under /jobs so a
// second consumer does not have to pretend to be a job.
api.route(
  "/users",
  createUserHandler({
    authMw: container.resolve("authMw"),
    userService: container.resolve("userService"),
  }),
);

// Reference lists from mes-master-data, behind a 5-minute cache that serves the
// last known good list when upstream is down. Namespaced by their OWNER rather
// than mounted as /areas — these are not this service's resources, and modelling
// them as if they were would invite somebody to add a write.
api.route(
  "/master-data",
  createMasterDataHandler({
    authMw: container.resolve("authMw"),
    masterDataService: container.resolve("masterDataService"),
  }),
);

app.route("/", api);

app.notFound((c) => {
  return c.json(WebResponse.builder<string>().error("not found page").build(), 404);
});

app.onError(async (err, c) => {
  const mapped = mapDomainError(err);
  if (mapped !== null) {
    const errRes = mapped.getResponse();
    const errMessage: string = await errRes.text();
    const errStatus: ContentfulStatusCode = errRes.status as ContentfulStatusCode;
    return c.json(WebResponse.builder<string>().error(errMessage).build(), errStatus);
  }

  const log = getRequestContext()?.logger ?? baseLogger;
  log.withMetadata({ err: serializeError(err) }).error("internal_server_error");
  return c.json(WebResponse.builder<string>().error("internal server error").build(), 500);
});

export { container };
export default app;
