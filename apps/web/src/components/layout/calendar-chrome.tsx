import { createContext, useContext, useMemo, useState } from "react";

import { useCalendarSearch } from "@/lib/calendar-search";
import { ActivityDrawer } from "@/components/calendar/activity-drawer";
import { JobDetailSheet } from "@/components/job/job-detail-sheet";
import { JobDialog } from "@/components/job/job-dialog";

import type { ReactNode } from "react";

// THE OVERLAYS, AND WHO IS ALLOWED TO OPEN THEM.
//
// WHY THIS EXISTS AT ALL
//
// "Create Job" and "Log Activity" are buttons in the SIDEBAR, which the `_app`
// layout mounts ABOVE the route. The dialogs they open belong to the page.
// Without something in between, the layout would have to reach into the page or
// the page would have to render controls it does not own.
//
// So the overlays are mounted HERE, beside the sidebar, and everything that can
// open one asks this context. The tabs use it too — the Table's Edit opens the
// same dialog the sidebar's Create does, and there is exactly one of it on the
// page.
//
//   _app.tsx
//     └─ CalendarChromeProvider ──renders──▶ JobDialog · JobDetailSheet · ActivityDrawer
//          ├─ AppSidebar   ──openCreate / openActivity
//          ├─ AppHeader
//          └─ Outlet (the tabs)
//               ├─ Table     ──openEdit(jobId) · openDetail(jobId)
//               ├─ Calendar  ──openDetail(jobId, businessDate)   (a block)
//               └─ Gantt     ──openDetail(jobId, businessDate)   (a bar)
//
// A CLICK OPENS THE READ-ONLY DETAIL, NEVER THE EDIT DIALOG. Looking is far more
// common than changing, and an edit replaces a whole plan: a form on click would
// put every glance one keystroke from re-planning a job. Edit is one deliberate
// button away — the Table's pencil, or the detail's own Edit, which hands off
// here (closing the detail first, so the two never stack).
//
// WHAT IS DELIBERATELY *NOT* HERE: the tab, the view mode, the range and the
// filters. Those stay in the URL (lib/calendar-search.ts) because they are worth
// sharing in a link. Whether a dialog happens to be open is not.

type CalendarChrome = {
  openCreate: () => void;
  // The same dialog, prefilled from GET /jobs/:id (decision 10A).
  openEdit: (jobId: number) => void;
  // The read-only detail. `date` is the business date to open on — the day of
  // the block or bar clicked; the Table has none and opens the first day.
  openDetail: (jobId: number, date?: string) => void;
  openActivity: () => void;
};

const CalendarChromeContext = createContext<CalendarChrome | null>(null);

function CalendarChromeProvider({ children }: { children: ReactNode }) {
  const { range, anchor } = useCalendarSearch();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [detail, setDetail] = useState<{ jobId: number; date?: string } | undefined>();
  const [detailOpen, setDetailOpen] = useState(false);

  // The job being edited, held as an ID rather than an object, so the dialog
  // always opens on the SERVER's current version rather than on whatever a
  // table row happened to be carrying.
  const [editingId, setEditingId] = useState<number | undefined>();

  const chrome = useMemo<CalendarChrome>(
    () => ({
      openCreate: () => {
        setEditingId(undefined);
        setDialogOpen(true);
      },
      openEdit: (jobId: number) => {
        setEditingId(jobId);
        setDialogOpen(true);
      },
      openDetail: (jobId: number, date?: string) => {
        setDetail({ jobId, date });
        setDetailOpen(true);
      },
      openActivity: () => setActivityOpen(true),
    }),
    [],
  );

  return (
    <CalendarChromeContext value={chrome}>
      {children}

      <JobDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          // Cleared on close so the next "Create Job" is not seeded with the job
          // that was last edited.
          if (!open) setEditingId(undefined);
        }}
        jobId={editingId}
        // A new job starts on the sidebar's range when one is picked — the
        // planner is usually looking at the days they are about to plan.
        defaultRange={range ?? { from: anchor, to: anchor }}
      />

      {/* The job id outlives `open` on purpose: clearing it on close would
          blank the sheet's contents during its slide-out animation. */}
      <JobDetailSheet
        jobId={detail?.jobId}
        focusDate={detail?.date}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onEdit={(jobId) => {
          setDetailOpen(false);
          chrome.openEdit(jobId);
        }}
      />

      <ActivityDrawer open={activityOpen} onOpenChange={setActivityOpen} />
    </CalendarChromeContext>
  );
}

function useCalendarChrome(): CalendarChrome {
  const value = useContext(CalendarChromeContext);
  if (!value) throw new Error("useCalendarChrome must be used inside <CalendarChromeProvider>");
  return value;
}

export { CalendarChromeProvider, useCalendarChrome };
