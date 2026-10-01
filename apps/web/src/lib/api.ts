import { isAxiosError } from "axios";

import { http } from "@/lib/http";

import type {
  ActivityEntry,
  AreaSummary,
  Job,
  JobBody,
  JobPage,
  JobRole,
  JobSummary,
  Me,
  PlanItemList,
  PlanPreview,
  ProductSummary,
  RoleUser,
  ShiftBlockList,
  WebResponse,
  WorkCenterSummary,
  WorkUnitSummary,
} from "@/lib/types";

// core-api resources are reached through the BFF proxy, which prefixes them
// with /api/proxy and swaps the session cookie for a bearer token. New resource
// calls belong on this prefix rather than hitting core-api directly — the
// browser has no token to present, and core-api's CORS only admits the BFF.
//
// The prefix must also be allow-listed in the BFF's PROXY_ALLOWED_PREFIXES.
const PROXY_PREFIX = "/api/proxy/api/v1";

const MASTER_DATA = `${PROXY_PREFIX}/master-data`;
const JOBS = `${PROXY_PREFIX}/jobs`;

// Returns the current user, or null when not authenticated.
async function getMe(): Promise<Me | null> {
  try {
    const { data } = await http.get<WebResponse<Me>>("/api/me", { authProbe: true });
    return data.data;
  } catch (err) {
    if (isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403)) {
      return null;
    }
    throw err;
  }
}

// Full-page navigations: the BFF answers with redirects (to the IdP / back to
// the app), so these must not go through axios — and must never become router
// <Link>s or navigate() calls either, since a client-side navigation cannot
// follow a cross-origin 302.
function login(returnTo = "/"): void {
  globalThis.location.href = `/api/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function logout(): void {
  globalThis.location.href = "/api/logout";
}

// ---------------------------------------------------------------------------
// master-data catalogues
// ---------------------------------------------------------------------------

// Areas for the header's area picker. Reference data — cached long, see queries.ts.
async function getAreas(): Promise<AreaSummary[]> {
  const { data } = await http.get<WebResponse<AreaSummary[]>>(`${MASTER_DATA}/areas`);
  return data.data ?? [];
}

// Lines within one area. `areaId` is required upstream — a request without it is
// a 400 — so callers gate on a chosen area.
async function getWorkCenters(areaId: number): Promise<WorkCenterSummary[]> {
  const { data } = await http.get<WebResponse<WorkCenterSummary[]>>(`${MASTER_DATA}/work-centers`, {
    params: { areaId },
  });
  return data.data ?? [];
}

// The machines on one line. `workCenterId` is REQUIRED upstream for the same
// reason `areaId` is above.
async function getWorkUnits(workCenterId: number): Promise<WorkUnitSummary[]> {
  const { data } = await http.get<WebResponse<WorkUnitSummary[]>>(`${MASTER_DATA}/work-units`, {
    params: { workCenterId },
  });
  return data.data ?? [];
}

// The SKUs one line produces — what the plan template lists per machine, and
// whose `code` the CSV is matched on server-side.
async function getLineProducts(workCenterId: number): Promise<ProductSummary[]> {
  const { data } = await http.get<WebResponse<ProductSummary[]>>(`${MASTER_DATA}/products`, {
    params: { workCenterId },
  });
  return data.data ?? [];
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// The members of the realm role a picker offers. A failure here is 502 or 503
// with a readable `error` string ("service account lacks view-users") — which
// errorMessage() below surfaces, because an empty picker after a failed fetch
// reads as "nobody holds this role", and the planner would save a job with no
// manager on it believing that to be true.
async function getRoleUsers(role: JobRole): Promise<RoleUser[]> {
  const { data } = await http.get<WebResponse<RoleUser[]>>(`${PROXY_PREFIX}/users`, {
    params: { role },
  });
  return data.data ?? [];
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

// The filters every window read shares. `to` is EXCLUSIVE, like every window in
// this codebase; the URL's inclusive range is converted in ONE place
// (lib/calendar-search.ts `rangeWindow`) before it gets here.
type WindowParams = {
  from: string;
  to: string;
  workCenterIds: number[];
  workUnitIds: number[];
};

type JobListParams = Partial<Pick<WindowParams, "from" | "to">> &
  Pick<WindowParams, "workCenterIds" | "workUnitIds"> & {
    page: number;
    size: number;
  };

// ARRAYS GO ON THE WIRE COMMA-JOINED, and an empty one is OMITTED. axios would
// otherwise write `workCenterIds[]=1&workCenterIds[]=2`, which the api's query
// schema does not read — the filter would silently do nothing — and an empty
// `workCenterIds=` would be parsed as a filter matching no line at all.
function idsParam(ids: number[]): string | undefined {
  return ids.length === 0 ? undefined : ids.join(",");
}

function filterParams({
  workCenterIds,
  workUnitIds,
}: Pick<WindowParams, "workCenterIds" | "workUnitIds">) {
  return {
    workCenterIds: idsParam(workCenterIds),
    workUnitIds: idsParam(workUnitIds),
  };
}

// The Calendar tab's read: one block per (job, business date, shift), instants
// already built on the server.
async function getShiftBlocks(params: WindowParams): Promise<ShiftBlockList> {
  const { data } = await http.get<WebResponse<ShiftBlockList>>(`${JOBS}/shifts`, {
    params: { from: params.from, to: params.to, ...filterParams(params) },
  });
  return data.data ?? { blocks: [], truncated: false };
}

// The Gantt tab's read. The server refuses a window wider than 31 days, which
// is why the Gantt clips its range BEFORE asking (components/job/gantt-view.tsx).
async function getPlanItems(params: WindowParams): Promise<PlanItemList> {
  const { data } = await http.get<WebResponse<PlanItemList>>(`${JOBS}/plan`, {
    params: { from: params.from, to: params.to, ...filterParams(params) },
  });
  return data.data ?? { items: [], truncated: false };
}

// The Table tab's read, server-paged. `meta` is carried out of the envelope
// rather than dropped, because the pager is nothing without it.
async function getJobs(params: JobListParams): Promise<JobPage> {
  const { data } = await http.get<WebResponse<JobSummary[]>>(JOBS, {
    params: {
      page: params.page,
      size: params.size,
      from: params.from,
      to: params.to,
      ...filterParams(params),
    },
  });
  return { rows: data.data ?? [], meta: data.meta };
}

async function getJob(id: number): Promise<Job> {
  const { data } = await http.get<WebResponse<Job>>(`${JOBS}/${id}`);
  if (!data.data) throw new Error("job not found");
  return data.data;
}

// A SAVE THE SERVER REFUSED BECAUSE OF THE PLAN, carrying the same PlanPreview
// preview answers with. Its own class rather than a message string, because the
// dialog's reaction is different in kind: a plan rejection keeps the planner on
// the Confirm step with the row errors listed; anything else is a toast.
//
// Why a save can fail after a clean preview at all: master data can change in
// between (a machine moved lines, a SKU retired), and another planner can save
// an overlapping job first (409). The server re-resolves on save for exactly
// that reason.
class PlanRejectedError extends Error {
  readonly preview: PlanPreview;
  readonly status: number;

  constructor(preview: PlanPreview, status: number) {
    super(status === 409 ? "the plan clashes with another job" : "the plan has issues");
    this.name = "PlanRejectedError";
    this.preview = preview;
    this.status = status;
  }
}

function isPlanPreview(value: unknown): value is PlanPreview {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as PlanPreview).issues) &&
    Array.isArray((value as PlanPreview).rows)
  );
}

// 400 and 409 carry a PlanPreview when the PLAN is the problem. A 400 from dto
// validation carries `{message, fields}` instead, and must NOT be mistaken for a
// plan with zero issues — which would leave the dialog on Confirm with nothing
// listed and a Save that keeps failing.
function rethrowPlanRejection(err: unknown): never {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as WebResponse<unknown> | undefined;
    if ((status === 400 || status === 409) && isPlanPreview(body?.data)) {
      throw new PlanRejectedError(body.data, status);
    }
  }
  throw err;
}

// Resolves the plan against master data and writes NOTHING. Always 200 with a
// PlanPreview unless the body itself is malformed.
//
// `jobId` IN EDIT MODE, and only then. The cross-job conflict check (decision
// 7A) looks for any other job already holding a machine on a date and shift —
// and without being told which job is being edited, the job's OWN saved rows
// are that other job. Every row of an unchanged plan would come back as a
// conflict with itself.
async function previewPlan(body: JobBody, jobId?: number): Promise<PlanPreview> {
  const { data } = await http.post<WebResponse<PlanPreview>>(`${JOBS}/preview`, body, {
    params: jobId === undefined ? undefined : { jobId },
  });
  if (!data.data) throw new Error("preview returned nothing");
  return data.data;
}

async function createJob(body: JobBody): Promise<Job> {
  try {
    const { data } = await http.post<WebResponse<Job>>(JOBS, body);
    if (!data.data) throw new Error("create returned no job");
    return data.data;
  } catch (err) {
    rethrowPlanRejection(err);
  }
}

// The plan is REPLACED wholesale — there is no per-row edit (decision 10A).
async function updateJob(id: number, body: JobBody): Promise<Job> {
  try {
    const { data } = await http.put<WebResponse<Job>>(`${JOBS}/${id}`, body);
    if (!data.data) throw new Error("update returned no job");
    return data.data;
  } catch (err) {
    rethrowPlanRejection(err);
  }
}

// THE AUDIT TRAIL. Read-only — there is no write call, because entries are
// written by the mutations themselves inside their own transactions. A client
// that could append to the log could forge it.
//
// `before` is the last id of the previous page, not an offset: the log is
// append-only and is written to while somebody reads it, so an offset shifts
// under the reader and page two repeats a row from page one.
async function getActivity(limit: number, before?: number): Promise<ActivityEntry[]> {
  const { data } = await http.get<WebResponse<ActivityEntry[]>>(`${JOBS}/activity`, {
    params: { limit, ...(before === undefined ? {} : { before }) },
  });
  return data.data ?? [];
}

// THE SERVER'S OWN WORDS, when it sent any. Every error this api answers is the
// envelope with a readable `error` (and, for a dto 400, `data.message`); axios's
// "Request failed with status code 502" says nothing a planner can act on.
function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (isAxiosError(err)) {
    const body = err.response?.data as WebResponse<{ message?: unknown }> | undefined;
    const detail = body?.data?.message;
    if (typeof detail === "string" && detail !== "") return detail;
    if (typeof body?.error === "string" && body.error !== "") return body.error;
  }
  return err instanceof Error && err.message !== "" ? err.message : fallback;
}

export {
  PROXY_PREFIX,
  PlanRejectedError,
  createJob,
  errorMessage,
  getActivity,
  getAreas,
  getJob,
  getJobs,
  getLineProducts,
  getMe,
  getPlanItems,
  getRoleUsers,
  getShiftBlocks,
  getWorkCenters,
  getWorkUnits,
  login,
  logout,
  previewPlan,
  updateJob,
};
export type { JobListParams, WindowParams };
