import { describe, it, expect, vi } from "vite-plus/test";

import { createHealthHandler } from "./health-handler.js";

import type { DependencyState, Probe } from "./health-service.js";

function probe(state: DependencyState): Probe & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn().mockResolvedValue(state) };
}

// Both dependencies healthy, overridable per test.
function healthyDeps(overrides: Partial<Record<"keycloak" | "job", Probe>> = {}) {
  return {
    keycloakProbe: overrides.keycloak ?? probe({ ok: true }),
    jobScheduleProbe: overrides.job ?? probe({ ok: true }),
  };
}

describe("GET /liveness", () => {
  it("returns 200 without touching the probes", async () => {
    const keycloakProbe = probe({ ok: true });
    const jobScheduleProbe = probe({ ok: true });
    const app = createHealthHandler({ keycloakProbe, jobScheduleProbe });

    const res = await app.request("/liveness");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(keycloakProbe.execute).not.toHaveBeenCalled();
    expect(jobScheduleProbe.execute).not.toHaveBeenCalled();
  });
});

describe("GET /readiness", () => {
  it("returns 200 and ok when all dependencies are healthy", async () => {
    const app = createHealthHandler(healthyDeps());

    const res = await app.request("/readiness");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.dependencies).toEqual({
      keycloak: { ok: true },
      job: { ok: true },
    });
  });

  it("returns 503 and degraded when the database is down", async () => {
    const app = createHealthHandler(
      healthyDeps({ job: probe({ ok: false, error: "conn refused" }) }),
    );

    const res = await app.request("/readiness");
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.dependencies.job).toEqual({ ok: false, error: "conn refused" });
    expect(body.dependencies.keycloak).toEqual({ ok: true });
  });

  it("returns 503 and degraded when Keycloak is down", async () => {
    // Every route on this service is authenticated, so an unreachable IdP means
    // nothing can be served — readiness must fail rather than accept traffic it
    // will 401.
    const app = createHealthHandler(
      healthyDeps({ keycloak: probe({ ok: false, error: "jwks timed out" }) }),
    );

    const res = await app.request("/readiness");
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    // The two report independently — a Keycloak outage must not be attributed
    // to the database.
    expect(body.dependencies.keycloak).toEqual({ ok: false, error: "jwks timed out" });
    expect(body.dependencies.job).toEqual({ ok: true });
  });

  it("caches the snapshot within the TTL and refreshes after it expires", async () => {
    let clock = 1_000;
    const deps = healthyDeps();
    const app = createHealthHandler({ ...deps, cacheTtlMs: 5_000, now: () => clock });

    const executions = () =>
      [deps.keycloakProbe, deps.jobScheduleProbe].map(
        (p) => (p.execute as ReturnType<typeof vi.fn>).mock.calls.length,
      );

    await app.request("/readiness");
    await app.request("/readiness");
    expect(executions()).toEqual([1, 1]);

    clock = 7_000; // past expiresAt (1000 + 5000)
    await app.request("/readiness");
    expect(executions()).toEqual([2, 2]);
  });
});
