import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PLANT_TIME_ZONE, useCalendarSearch, validateCalendarSearch } from "@/lib/calendar-search";
import { SCHEDULE_TABS } from "@/lib/types";
import { useCalendarChrome } from "@/components/layout/calendar-chrome";
import { CalendarView } from "@/components/calendar/calendar-view";
import { GanttView } from "@/components/job/gantt-view";
import { JobTable } from "@/components/job/job-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { ScheduleTab } from "@/lib/types";

// THE MODULE'S ONE PAGE: three tabs over the same jobs.
//
//   [ Calendar | Table | Gantt ]        <- `tab` in the URL, Calendar by default
//   ┌──────────────────────────────┐
//   │ the tab's body               │    each reads the SAME range and filters
//   └──────────────────────────────┘    from the URL; only what it draws differs
//
// The controls that drive all three — the date range, the line and machine
// pickers, Create Job — live in the app shell, because they are chrome rather
// than page content and because the mock puts them there.
//
// The route still OWNS the search-param contract (`validateSearch`), even though
// the sidebar and header read and write it too. One parser, one place where a
// malformed URL is decided — see lib/calendar-search.ts.
//
// ONLY THE ACTIVE TAB IS MOUNTED (Radix unmounts inactive content), so opening
// the page fetches the Calendar's blocks and nothing else — a Table or Gantt
// request is made when somebody looks at one.
export const Route = createFileRoute("/_app/calendar")({
  validateSearch: validateCalendarSearch,
  staticData: {
    title: "nav.jobSchedule",
    description: "nav.jobScheduleDescription",
    breadcrumbs: [{ label: "nav.jobSchedule" }],
  },
  component: CalendarRoute,
});

const TAB_KEYS: Record<ScheduleTab, string> = {
  calendar: "nav.calendar",
  table: "nav.table",
  gantt: "nav.gantt",
};

function CalendarRoute() {
  const { t } = useTranslation("jobs");
  const { tab, view, anchor, range, lines, machines, page, size, setSearch } = useCalendarSearch();
  const { openEdit, openDetail } = useCalendarChrome();
  const filters = { workCenterIds: lines, workUnitIds: machines };

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setSearch({ tab: next as ScheduleTab })}
      className="gap-3"
    >
      <TabsList>
        {SCHEDULE_TABS.map((tabName) => (
          <TabsTrigger key={tabName} value={tabName} className="px-4">
            {t(TAB_KEYS[tabName])}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="calendar">
        <CalendarView
          viewMode={view}
          anchor={anchor}
          timeZone={PLANT_TIME_ZONE}
          filters={filters}
          onAnchorChange={(date) => setSearch({ date })}
          onViewModeChange={(next) => setSearch({ view: next })}
          onSelectBlock={(block) => openDetail(block.jobId, block.occurrenceDate)}
        />
      </TabsContent>

      <TabsContent value="table">
        <JobTable
          range={range}
          filters={filters}
          page={page}
          size={size}
          onPageChange={(next) => setSearch({ page: next })}
          onSizeChange={(next) => setSearch({ size: next })}
          onEdit={openEdit}
          onDetail={openDetail}
        />
      </TabsContent>

      <TabsContent value="gantt">
        <GanttView
          range={range}
          filters={filters}
          timeZone={PLANT_TIME_ZONE}
          onSelectBar={(jobId, date) => openDetail(jobId, date)}
        />
      </TabsContent>
    </Tabs>
  );
}
