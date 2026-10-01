import { describe, expect, it, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";

import { createJobHandler } from "./job-handler.js";
import { PlanRejectedError } from "./job-service.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";

// ROUTE MATCHING and the rejected-plan envelope.
//
// `/shifts`, `/plan`, `/activity` and `/preview` sit beside `/:id`. Hono matches in
// registration order, and probing the running service cannot show a swallowed
// route: every path is behind authMw, so a wrong match 401s exactly as readily as
// a right one. Stubbing auth and watching which service method runs is the only
// way to see it.
const auth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "kc-sub-1", preferred_username: "planner" });
  await next();
}) as AuthMiddleware;

const body = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  plan: [
    {
      row: 1,
      date: "2026-10-01",
      line: "L1",
      sku: "A",
      skuCode: "A",
      target: 1,
      machine: "M1",
      shift1: true,
      shift2: false,
      shift3: false,
    },
  ],
};

function setup() {
  const service = {
    listJobs: vi.fn().mockResolvedValue({ items: [], totalElements: 23 }),
    listShiftBlocks: vi.fn().mockResolvedValue({ blocks: [], truncated: false }),
    listPlanItems: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    listActivity: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue({ id: 7 }),
    preview: vi.fn().mockResolvedValue({ rows: [], issues: [], ignoredRows: 0 }),
    create: vi.fn().mockResolvedValue({ id: 8 }),
    update: vi.fn().mockResolvedValue({ id: 7 }),
  };
  const app = createJobHandler({ authMw: auth, jobService: service as never });
  return { app, service };
}

const json = (payload: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

describe("the named routes are not swallowed by /:id", () => {
  it.for([
    ["/shifts?from=2026-09-21&to=2026-09-28", "listShiftBlocks"],
    ["/plan?from=2026-09-21&to=2026-09-28", "listPlanItems"],
    ["/activity", "listActivity"],
  ] as const)("routes %s to %s", async ([path, method]) => {
    const { app, service } = setup();

    const res = await app.request(path);

    expect(res.status).toBe(200);
    expect(service[method]).toHaveBeenCalledTimes(1);
    expect(service.getById).not.toHaveBeenCalled();
  });

  it("routes POST /preview to preview, not create", async () => {
    const { app, service } = setup();

    const res = await app.request("/preview", json(body));

    expect(res.status).toBe(200);
    expect(service.preview).toHaveBeenCalledWith(expect.any(Object), undefined);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("passes an edit preview's jobId through so the job ignores its own rows", async () => {
    const { app, service } = setup();

    await app.request("/preview?jobId=7", json(body));

    expect(service.preview).toHaveBeenCalledWith(expect.any(Object), 7);
  });
});

describe("GET /", () => {
  it("answers with PageMeta built from the page, size and total", async () => {
    const { app } = setup();

    const res = await app.request("/?page=2&size=10&workCenterIds=1,2");
    const payload = (await res.json()) as { meta: Record<string, unknown> };

    expect(payload.meta).toEqual({
      page: 2,
      size: 10,
      totalElements: 23,
      totalPages: 3,
      first: false,
      last: false,
    });
  });
});

describe("a refused plan", () => {
  // The builder clears `data` when an error is set; the handler must not, or the
  // dialog loses the very issues the planner has to fix.
  it("answers with the preview's shape AND the error, at the error's status", async () => {
    const { app, service } = setup();
    const preview = {
      rows: [],
      issues: [{ row: 1, field: "line", message: "unknown line" }],
      ignoredRows: 0,
    };
    service.create.mockRejectedValueOnce(new PlanRejectedError(preview));

    const res = await app.request("/", json(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ data: preview, error: "plan has issues" });
  });

  it("uses 409 when every issue is another job's claim", async () => {
    const { app, service } = setup();
    service.update.mockRejectedValueOnce(
      new PlanRejectedError({
        rows: [],
        issues: [{ row: 1, field: "shift2", message: "already planned" }],
        ignoredRows: 0,
      }),
    );

    const res = await app.request("/7", { ...json(body), method: "PUT" });

    expect(res.status).toBe(409);
  });

  it("stamps the actor from the token, never the body", async () => {
    const { app, service } = setup();

    await app.request("/", json({ ...body, createdById: "somebody-else" }));

    expect(service.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ createdById: expect.anything() }),
      expect.objectContaining({ subject: "kc-sub-1" }),
    );
  });
});

describe("ids", () => {
  it("400s a non-numeric id instead of reaching SQL with NaN", async () => {
    const { app } = setup();
    const res = await app.request("/abc");
    expect(res.status).toBe(400);
  });
});
