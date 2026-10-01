import { queryOptions, useQuery } from "@tanstack/react-query";

import { useInfiniteQuery, useQueries } from "@tanstack/react-query";

import {
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
} from "@/lib/api";

import type { JobListParams, WindowParams } from "@/lib/api";
import type { JobRole } from "@/lib/types";

// Option objects rather than inline hook config, so route loaders can prefetch
// the same queries the components subscribe to (`ensureQueryData`).
//
// NOTHING IN THIS FILE WRITES. Route loaders import from here, and a loader that
// could reach a mutation is a page that mutates on navigation — see
// lib/mutations.ts. The import line at the top is the one-glance proof.

const meKey = ["me"] as const;

// `retry: false` matters: an unauthenticated visitor gets a 401, which is a
// normal answer rather than a transient failure — retrying only delays the
// redirect to login.
const meQueryOptions = queryOptions({
  queryKey: meKey,
  queryFn: getMe,
  staleTime: 5 * 60 * 1000,
  retry: false,
});

function useMe() {
  return useQuery(meQueryOptions);
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

// Small, rarely edited, and read by the header and both pickers on every screen.
//
// WHY THE CATALOGUES ARE FETCHED WHOLE AND FILTERED IN THE BROWSER. A server
// `?q=` would be a request per keystroke against a list of a few dozen rows that
// changes on the order of weeks, and it would make the picker unusable exactly
// when upstream is slow. One fetch per line per five minutes, filtered locally,
// is both fewer requests and a picker that keeps typing at network speed.
const REFERENCE_STALE_TIME = 5 * 60 * 1000;

const areasKey = ["areas"] as const;

const areasQueryOptions = queryOptions({
  queryKey: areasKey,
  queryFn: getAreas,
  staleTime: REFERENCE_STALE_TIME,
});

function useAreas() {
  return useQuery(areasQueryOptions);
}

// `enabled` is the cascade gate: core-api 400s a work-center request with no
// areaId, so nothing may fire until the header has settled on an area.
//
// THE TRAP THAT GATE CARRIES, stated once here because all three cascaded
// queries below share it: a query with `enabled: false` reports
// `status: "pending"` FOREVER. A component that checks `isPending` first renders
// a skeleton that never resolves. Check the gate itself before the query state —
// calendar-view.test.tsx asserts exactly this.
function workCentersQueryOptions(areaId: number | undefined) {
  return queryOptions({
    queryKey: ["work-centers", areaId] as const,
    queryFn: () => getWorkCenters(areaId as number),
    staleTime: REFERENCE_STALE_TIME,
    enabled: areaId !== undefined,
  });
}

function useWorkCenters(areaId: number | undefined) {
  return useQuery(workCentersQueryOptions(areaId));
}

function workUnitsQueryOptions(workCenterId: number | undefined) {
  return queryOptions({
    queryKey: ["work-units", workCenterId] as const,
    queryFn: () => getWorkUnits(workCenterId as number),
    staleTime: REFERENCE_STALE_TIME,
    enabled: workCenterId !== undefined,
  });
}

function useWorkUnits(workCenterId: number | undefined) {
  return useQuery(workUnitsQueryOptions(workCenterId));
}

// The SKUs of one line, for the plan template. Gated like the rosters above.
function lineProductsQueryOptions(workCenterId: number | undefined) {
  return queryOptions({
    queryKey: ["line-products", workCenterId] as const,
    queryFn: () => getLineProducts(workCenterId as number),
    staleTime: REFERENCE_STALE_TIME,
    enabled: workCenterId !== undefined,
  });
}

function useLineProducts(workCenterId: number | undefined) {
  return useQuery(lineProductsQueryOptions(workCenterId));
}

// THE MACHINES ON SEVERAL LINES AT ONCE, one query per line.
//
// Fanned out over the SAME per-line entries `useWorkUnits` reads, rather than a
// multi-line endpoint with a key of its own: the header's machine picker, the
// dialog's template and anything else asking about line 3 then share one cache
// entry for it, and adding a fourth line to a selection costs one request, not a
// refetch of all four.
//
// `useQueries`, not a hook per slot. A fixed number of `useWorkUnits` calls (the
// event dialog this replaced had four) silently drops the fifth line a planner
// selects — no error, just a machine list that is short.
function useWorkUnitsForLines(lineIds: number[]) {
  return useQueries({
    queries: lineIds.map((id) => workUnitsQueryOptions(id)),
    combine: (results) => ({
      // Each machine tagged with the line it came from, which is what lets the
      // header prune machines when a line is deselected.
      units: results.flatMap((result, index) =>
        (result.data ?? []).map((unit) => ({ ...unit, workCenterId: lineIds[index]! })),
      ),
      pending: results.some((result) => result.data === undefined && !result.isError),
      error: results.find((result) => result.isError)?.error ?? null,
    }),
  });
}

// The SKUs of several lines, fanned out the same way.
function useLineProductsForLines(lineIds: number[]) {
  return useQueries({
    queries: lineIds.map((id) => lineProductsQueryOptions(id)),
    combine: (results) => ({
      byLine: new Map(lineIds.map((id, index) => [id, results[index]?.data])),
      pending: results.some((result) => result.data === undefined && !result.isError),
      error: results.find((result) => result.isError)?.error ?? null,
    }),
  });
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// The members of one realm role. The ROLE IS THE KEY: three pickers, three
// entries, and a Foreman list can never be served to the Manager picker.
//
// `retry: false` because the failures this call has are configuration, not
// weather — a role that does not exist in the realm, a service account without
// view-users. Retrying them three times only delays the message that says so.
function roleUsersQueryOptions(role: JobRole) {
  return queryOptions({
    queryKey: ["role-users", role] as const,
    queryFn: () => getRoleUsers(role),
    staleTime: REFERENCE_STALE_TIME,
    retry: false,
  });
}

function useRoleUsers(role: JobRole, enabled = true) {
  return useQuery({ ...roleUsersQueryOptions(role), enabled });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

// THE KEY CARRIES THE WHOLE WINDOW AND EVERY FILTER, and that is what makes
// paging back and forth free: each window is its own cache entry, so returning
// to last week is a cache read rather than a request.
//
// It also means the key and the request are built from ONE object. A key that
// listed fewer fields than the request would serve a cached answer for a
// different question — the classic symptom being a filter that appears to do
// nothing until a reload.
const shiftBlocksKey = (params: WindowParams) =>
  ["shifts", params.from, params.to, params.workCenterIds, params.workUnitIds] as const;

function shiftBlocksQueryOptions(params: WindowParams) {
  return queryOptions({
    queryKey: shiftBlocksKey(params),
    queryFn: () => getShiftBlocks(params),
    // Short: a job schedule is edited by people who are looking at it, so a
    // stale calendar is more confusing than an extra request is expensive.
    staleTime: 30 * 1000,
    // The previous window stays on screen while the next one loads, so paging
    // does not flash an empty grid over a calendar that was already drawn.
    placeholderData: (previous) => previous,
  });
}

function useShiftBlocks(params: WindowParams) {
  return useQuery(shiftBlocksQueryOptions(params));
}

const planItemsKey = (params: WindowParams) =>
  ["plan", params.from, params.to, params.workCenterIds, params.workUnitIds] as const;

function planItemsQueryOptions(params: WindowParams) {
  return queryOptions({
    queryKey: planItemsKey(params),
    queryFn: () => getPlanItems(params),
    staleTime: 30 * 1000,
    placeholderData: (previous) => previous,
  });
}

function usePlanItems(params: WindowParams) {
  return useQuery(planItemsQueryOptions(params));
}

const jobsKey = (params: JobListParams) =>
  [
    "jobs",
    params.page,
    params.size,
    params.from ?? null,
    params.to ?? null,
    params.workCenterIds,
    params.workUnitIds,
  ] as const;

function jobsQueryOptions(params: JobListParams) {
  return queryOptions({
    queryKey: jobsKey(params),
    queryFn: () => getJobs(params),
    staleTime: 30 * 1000,
    // NOT placeholderData here, unlike the two window reads. A table that keeps
    // page 2's rows on screen while page 3 loads numbers them 11–20 under a pager
    // saying "3" — the index column is computed from the page, not the rows.
  });
}

function useJobs(params: JobListParams) {
  return useQuery(jobsQueryOptions(params));
}

// ONE job, for the edit dialog. Keyed by id and read from the server every time
// the dialog opens on it, so an edit starts from what is saved rather than from
// whatever a table row happened to be carrying.
function jobQueryOptions(id: number | undefined) {
  return queryOptions({
    queryKey: ["job", id] as const,
    queryFn: () => getJob(id as number),
    enabled: id !== undefined,
    staleTime: 0,
  });
}

function useJob(id: number | undefined) {
  return useQuery(jobQueryOptions(id));
}

// THE AUDIT FEED, paged as the drawer scrolls.
//
// An infinite query rather than a plain one: the log grows without bound, and
// the cursor it pages on is the last id of the page before — which only an
// infinite query threads for you.
const ACTIVITY_PAGE_SIZE = 25;

const activityKey = ["activity"] as const;

function useActivityFeed(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: activityKey,
    queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
      getActivity(ACTIVITY_PAGE_SIZE, pageParam),
    initialPageParam: undefined as number | undefined,
    // A short page means the end. Returning a cursor from an empty page would
    // ask for the same nothing forever.
    getNextPageParam: (last) => (last.length < ACTIVITY_PAGE_SIZE ? undefined : last.at(-1)?.id),
    // Gated on the drawer being open: the feed is never on screen otherwise, and
    // fetching it on every page load would be a request nobody reads.
    enabled,
    staleTime: 30 * 1000,
  });
}

export {
  ACTIVITY_PAGE_SIZE,
  activityKey,
  areasKey,
  areasQueryOptions,
  jobQueryOptions,
  jobsKey,
  jobsQueryOptions,
  lineProductsQueryOptions,
  meKey,
  meQueryOptions,
  planItemsKey,
  planItemsQueryOptions,
  roleUsersQueryOptions,
  shiftBlocksKey,
  shiftBlocksQueryOptions,
  useActivityFeed,
  useAreas,
  useJob,
  useJobs,
  useLineProducts,
  useLineProductsForLines,
  useMe,
  usePlanItems,
  useRoleUsers,
  useShiftBlocks,
  useWorkCenters,
  useWorkUnits,
  useWorkUnitsForLines,
  workCentersQueryOptions,
  workUnitsQueryOptions,
};
