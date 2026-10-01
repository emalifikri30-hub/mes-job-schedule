import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createJob, previewPlan, updateJob } from "@/lib/api";
import { activityKey } from "@/lib/queries";

import type { Job, JobBody, PlanPreview } from "@/lib/types";

// THE WRITES THIS APP MAKES.
//
// WHY THIS IS NOT IN queries.ts
//
// Route loaders import from queries.ts, and nothing in a loader may ever import
// a mutation. A separate module makes that a structural fact rather than a
// review comment — and it keeps queries.ts's import line at
// `{ queryOptions, useQuery }`, which answers "does this file write?" at a
// glance.
//
// THREE RULES, EACH A DECISION RATHER THAN A DEFAULT
//
//   1. INVALIDATE EVERY READ THE JOB APPEARS IN, BY PREFIX. A save changes what
//      the Calendar draws, what the Gantt draws and which page of the Table a
//      job sits on — across windows and pages the planner is not looking at.
//      Each key carries its window or page, so there is no naming "the entries
//      this affected"; a prefix invalidate is the only correct answer.
//   2. NO OPTIMISTIC UPDATE. The server resolves the plan against master data,
//      freezes every name and unit, and stamps the actor from the token. The
//      client cannot produce any of it without putting a guess on screen.
//   3. `retry: false`, EXPLICITLY. A failed write must surface, not be retried
//      behind a spinner — and a retried POST is a second job.
const JOB_READ_PREFIXES = [["jobs"], ["shifts"], ["plan"]] as const;

function useInvalidateJobs() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      ...JOB_READ_PREFIXES.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      // Every save writes an audit entry, so the log is stale the moment one
      // succeeds. Forgetting this is how the drawer misses a change that is
      // already on screen everywhere else.
      queryClient.invalidateQueries({ queryKey: activityKey }),
    ]);
  };
}

// PREVIEW WRITES NOTHING and invalidates nothing — it is a mutation only because
// it is a POST carrying a body too large for a query key, and because a
// preview must run when the planner drops a file, not whenever a cache decides.
//
// `jobId` is the job being EDITED, so its own saved rows are not reported as
// conflicts with itself — see api.ts.
function usePreviewPlan() {
  return useMutation<PlanPreview, Error, { body: JobBody; jobId?: number }>({
    mutationFn: ({ body, jobId }) => previewPlan(body, jobId),
    retry: false,
  });
}

function useCreateJob() {
  const invalidate = useInvalidateJobs();
  return useMutation<Job, Error, JobBody>({
    mutationFn: createJob,
    retry: false,
    onSuccess: invalidate,
  });
}

function useUpdateJob() {
  const invalidate = useInvalidateJobs();
  const queryClient = useQueryClient();
  return useMutation<Job, Error, { id: number; body: JobBody }>({
    mutationFn: ({ id, body }) => updateJob(id, body),
    retry: false,
    onSuccess: async (updated) => {
      // Write through for the single-job entry the edit dialog reads, so
      // reopening it shows what was just saved rather than the previous values.
      queryClient.setQueryData(["job", updated.id], updated);
      await invalidate();
    },
  });
}

export { useCreateJob, usePreviewPlan, useUpdateJob };
