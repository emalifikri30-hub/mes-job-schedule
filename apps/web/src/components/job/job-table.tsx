import { EyeIcon, PencilIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { TFunction } from "i18next";

import { errorMessage } from "@/lib/api";
import { rangeWindow } from "@/lib/calendar-window";
import { formatCivilRange } from "@/lib/civil-date";
import { useJobs } from "@/lib/queries";
import { DataTable } from "@/components/table/data-table";
import { indexColumn } from "@/components/table/index-column";
import { TablePagination } from "@/components/table/table-pagination";
import { Button } from "@/components/ui/button";

import type { DateRange } from "@/lib/calendar-search";
import type { JobSummary } from "@/lib/types";
import type { ColumnDef } from "@tanstack/react-table";

// THE TABLE TAB: one row per job, newest first, server-paged.
//
//   No │ Date                                 │ Created By │ Action
//   ───┼──────────────────────────────────────┼────────────┼───────────────
//    1 │ Wed, 23 Sep 2026 – Fri, 25 Sep 2026  │ planner    │ [edit] [detail]
//    2 │ Mon, 21 Sep 2026                     │ planner    │ [edit] [detail]
//
// THE DATE COLUMN IS THE JOB'S RANGE (decision 11A), one date when it is one
// day long, and the sidebar range filters by OVERLAP — a job running 20–30 Sep
// belongs to a filter of 25–27 Sep, although neither of its ends is in it.
//
// DETAIL opens the read-only job sheet (components/job/job-detail-sheet.tsx),
// which groups the job's range BY DATE — the Date column says "23 – 25 Sep", and
// the sheet is where those three days are told apart. EDIT opens the form. Two
// buttons, never one that does both: a glance must not land in a form.
//
// PAGE AND SIZE ARE IN THE URL, like every other piece of view state, and a
// filter or size change resets the page (lib/calendar-search.ts `mergeSearch`)
// — page 7 of a newly narrowed list is usually past its end.

type JobTableProps = {
  range: DateRange | undefined;
  filters: { workCenterIds: number[]; workUnitIds: number[] };
  page: number;
  size: number;
  onPageChange: (page: number) => void;
  onSizeChange: (size: number) => void;
  onEdit: (jobId: number) => void;
  onDetail: (jobId: number) => void;
};

function buildColumns(
  t: TFunction<"jobs">,
  onEdit: (jobId: number) => void,
  onDetail: (jobId: number) => void,
): ColumnDef<JobSummary, unknown>[] {
  return [
    indexColumn<JobSummary>(t("jobs.no")),
    {
      id: "date",
      header: t("jobs.date"),
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {formatCivilRange(row.original.startDate, row.original.endDate)}
        </span>
      ),
    },
    {
      id: "createdBy",
      header: t("jobs.createdBy"),
      // The display name is nullable; the durable identity is the subject, and
      // "null" in a cell would be worse than the id.
      cell: ({ row }) => row.original.createdByName ?? row.original.createdById,
    },
    {
      id: "action",
      header: t("jobs.action"),
      meta: { headerClassName: "w-24", cellClassName: "w-24" },
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("jobs.editJobAria", { id: row.original.id })}
            title={t("jobs.edit")}
            onClick={() => onEdit(row.original.id)}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("jobs.detailJobAria", { id: row.original.id })}
            title={t("jobs.detail")}
            onClick={() => onDetail(row.original.id)}
          >
            <EyeIcon />
          </Button>
        </div>
      ),
    },
  ];
}

function JobTable({
  range,
  filters,
  page,
  size,
  onPageChange,
  onSizeChange,
  onEdit,
  onDetail,
}: JobTableProps) {
  const { t } = useTranslation("jobs");
  // The inclusive URL range as the half-open window the api takes — converted
  // in ONE place (lib/calendar-window.ts), never inline.
  const window = range === undefined ? undefined : rangeWindow(range);
  const query = useJobs({
    page,
    size,
    from: window?.from,
    to: window?.to,
    ...filters,
  });

  const columns = useMemo(() => buildColumns(t, onEdit, onDetail), [t, onEdit, onDetail]);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border">
        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          getRowId={(job) => String(job.id)}
          // On DATA, not `isPending`: the Table's query is never gated, but the
          // habit is what keeps a gated one from rendering skeletons forever.
          isPending={query.data === undefined && !query.isError}
          isError={query.isError}
          errorMessage={t("jobs.loadError", {
            message: errorMessage(query.error, t("jobs.requestFailed")),
          })}
          emptyMessage={
            range === undefined && filters.workCenterIds.length === 0
              ? t("jobs.empty")
              : t("jobs.noMatch")
          }
          skeletonRows={size}
          meta={{ page, size }}
        />
      </div>
      <TablePagination
        page={page}
        size={size}
        meta={query.data?.meta}
        onPageChange={onPageChange}
        onSizeChange={onSizeChange}
      />
    </div>
  );
}

export { JobTable };
