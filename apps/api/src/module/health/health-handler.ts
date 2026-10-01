import { Hono } from "hono";

import type { DependencyState, Probe } from "./health-service.js";

type HealthHandlerDeps = {
  keycloakProbe: Probe;
  jobScheduleProbe: Probe;
  // Overrides for tests.
  cacheTtlMs?: number;
  now?: () => number;
};

type ReadinessSnapshot = {
  expiresAt: number;
  ok: boolean;
  dependencies: Record<string, DependencyState>;
};

const DEFAULT_CACHE_TTL_MS = 5_000;

function createHealthHandler({
  keycloakProbe,
  jobScheduleProbe,
  cacheTtlMs,
  now,
}: HealthHandlerDeps) {
  const app = new Hono();

  const ttl = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = now ?? (() => Date.now());
  let snapshot: ReadinessSnapshot | null = null;
  let inflight: Promise<ReadinessSnapshot> | null = null;

  async function refresh(current: number): Promise<ReadinessSnapshot> {
    const [keycloak, job] = await Promise.all([
      keycloakProbe.execute(),
      jobScheduleProbe.execute(),
    ]);
    return {
      expiresAt: current + ttl,
      // BOTH gate readiness, and neither is optional. Every route on this
      // service is authenticated, so an unreachable IdP means nothing can be
      // served; the calendar has nothing to read without its database.
      //
      // mes-master-data is deliberately NOT probed here even though this service
      // calls it. Its reads are cached with a last-known-good fallback, so an
      // upstream outage degrades a picker rather than stopping the service — and
      // failing readiness for it would turn a degraded dependency into an outage
      // of our own.
      ok: keycloak.ok && job.ok,
      dependencies: { keycloak, job },
    };
  }

  app.get("/liveness", (c) => {
    return c.json(
      {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      200,
    );
  });

  app.get("/readiness", async (c) => {
    const current = clock();

    let snap = snapshot;
    if (!snap || snap.expiresAt <= current) {
      inflight ??= refresh(current).then((s) => {
        snapshot = s;
        inflight = null;
        return s;
      });
      snap = await inflight;
    }

    return c.json(
      {
        status: snap.ok ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        dependencies: snap.dependencies,
      },
      snap.ok ? 200 : 503,
    );
  });

  return app;
}

export { createHealthHandler };
export type { HealthHandlerDeps };
