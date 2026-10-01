import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { buildPageMeta, WebResponse } from "@molca/network";

import { requireActor } from "../../shared/actor.js";
import { jobValidator } from "./job-dto.js";
import { PlanRejectedError } from "./job-service.js";

import type { Context } from "hono";
import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { JobServiceContract } from "./job-service.js";
import type { ActivityEntry, Job, JobSummary, PlanItem, PlanPreview, ShiftBlock } from "./job.js";

// Routes for jobs, mounted at /api/v1/jobs.
//
//   GET  /            THE TABLE — job summaries, page/size, PageMeta
//   GET  /shifts      THE CALENDAR — one block per (job, business date, shift)
//   GET  /plan        THE GANTT — plan rows over a window of at most 31 days
//   GET  /activity    THE AUDIT TRAIL
//   POST /preview     resolve an uploaded plan and write NOTHING
//   GET  /:id         one job, with people and plan — what the edit dialog loads
//   POST /            create
//   PUT  /:id         replace the whole job, plan included
//
// THREE READS OF THE SAME ROWS, ON PURPOSE. The Table pages jobs, the Calendar
// aggregates rows into shift blocks, the Gantt wants the rows themselves. One
// endpoint with a `view` flag would make every caller's response a union to
// narrow, and would make the Table carry 560 plan rows per job to draw four
// columns.
//
// THERE IS NO DELETE, and no write route for the audit trail. The first is not
// in the requirement yet (TODOS); the second is by design — entries are written by
// the mutations themselves, and a route that appended to the log would let a
// caller forge it.

type Deps = {
  jobService: JobServiceContract;
  authMw: AuthMiddleware;
};

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, { message: "invalid job id" });
  }
  return id;
}

// A refused plan answers with the PREVIEW's shape plus an error string, so the
// dialog renders the same issue list whether the problem was found by Preview or
// by Save. Built by hand because WebResponse's builder clears `data` when an
// error is set — which here would throw away the very rows and issues the planner
// needs to fix the file.
async function withPlanRejection(c: Context, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PlanRejectedError) {
      return c.json({ data: err.preview satisfies PlanPreview, error: err.message }, err.status);
    }
    throw err;
  }
}

function createJobHandler({ jobService, authMw }: Deps) {
  const app = new Hono<AuthEnv>();
  app.use("*", authMw);

  app.get("/", jobValidator.listJobs, async (c) => {
    const query = c.req.valid("query");
    const { items, totalElements } = await jobService.listJobs(query);
    return c.json(
      WebResponse.builder<JobSummary[]>()
        .data(items)
        .meta(buildPageMeta(query.page, query.size, totalElements))
        .build(),
      200,
    );
  });

  // Every literal segment is registered BEFORE `/:id`, or it would match as an id
  // and parseId would reject "shifts" as a 400.
  app.get("/shifts", jobValidator.listShifts, async (c) => {
    const result = await jobService.listShiftBlocks(c.req.valid("query"));
    // `truncated` travels in the payload so no caller can read the blocks without
    // also being handed the fact that there were more.
    return c.json(
      WebResponse.builder<{ blocks: ShiftBlock[]; truncated: boolean }>().data(result).build(),
      200,
    );
  });

  app.get("/plan", jobValidator.listPlan, async (c) => {
    const result = await jobService.listPlanItems(c.req.valid("query"));
    return c.json(
      WebResponse.builder<{ items: PlanItem[]; truncated: boolean }>().data(result).build(),
      200,
    );
  });

  app.get("/activity", jobValidator.listActivity, async (c) => {
    const { limit, before } = c.req.valid("query");
    const entries = await jobService.listActivity(limit, before);
    return c.json(WebResponse.builder<ActivityEntry[]>().data(entries).build(), 200);
  });

  // ALWAYS 200 when the body is well-formed: issues are the ANSWER to a preview,
  // not a failure of it. `?jobId=` makes an edit's preview ignore the job's own
  // rows, exactly as the save will.
  app.post("/preview", jobValidator.write, async (c) => {
    const jobId = c.req.query("jobId");
    const preview = await jobService.preview(
      c.req.valid("json"),
      jobId === undefined ? undefined : parseId(jobId),
    );
    return c.json(WebResponse.builder<PlanPreview>().data(preview).build(), 200);
  });

  app.get("/:id", async (c) => {
    const job = await jobService.getById(parseId(c.req.param("id")));
    return c.json(WebResponse.builder<Job>().data(job).build(), 200);
  });

  // WHO is read from the VERIFIED TOKEN, never from the body: `created_by_id` is
  // an audit column, and accepting it from the request would let a caller
  // attribute a plan to somebody else.
  app.post("/", jobValidator.write, async (c) => {
    const actor = requireActor(c);
    return await withPlanRejection(c, async () => {
      const created = await jobService.create(c.req.valid("json"), actor);
      return c.json(WebResponse.builder<Job>().data(created).build(), 201);
    });
  });

  app.put("/:id", jobValidator.write, async (c) => {
    const actor = requireActor(c);
    const id = parseId(c.req.param("id"));
    return await withPlanRejection(c, async () => {
      const updated = await jobService.update(id, c.req.valid("json"), actor);
      return c.json(WebResponse.builder<Job>().data(updated).build(), 200);
    });
  });

  return app;
}

export { createJobHandler };
