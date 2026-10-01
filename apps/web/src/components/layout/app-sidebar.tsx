import { useTranslation } from "react-i18next";
import { CalendarPlusIcon, ScrollTextIcon } from "lucide-react";

import { PLANT_TIME_ZONE, useCalendarSearch } from "@/lib/calendar-search";
import { useCalendarChrome } from "@/components/layout/calendar-chrome";
import { AreaSelect } from "@/components/layout/area-select";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LanguageSwitcher } from "@/components/switcher/language-switcher";
import { AppSwitcher } from "@/components/switcher/app-switcher";
import { UserMenu } from "@/components/layout/user-menu";
import { formatCivilRange } from "@/lib/civil-date";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import { JobFilters } from "@/components/job/job-filters";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { LucideIcon } from "lucide-react";

// THE SIDEBAR IS A CONTROL PANEL, NOT A NAV TREE.
//
// This module has ONE screen, so a route list would be a tree pretending to be
// a menu. What lives here instead is what a planner reaches for: create a job,
// pick the date range, read the audit log.
//
//   ┌──────────────────────────┐
//   │ [icon] Job Schedule      │  app switcher — toggle lives in the header
//   │ [     + Create Job     ] │
//   │ 23 Sep – 25 Sep 2026  ✕  │  the picked range, in words
//   │ ┌──────────────────────┐ │
//   │ │  mini calendar RANGE │ │  the date range the tabs read
//   │ └──────────────────────┘ │
//   │ ──────────────────────── │  divider
//   │ [  Log Activity        ] │
//   │ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
//   │ lines · machines         │  MOBILE ONLY — see below
//   │ EN · AREA                │
//   │ [avatar] name · email    │  footer — always, like master-data
//   └──────────────────────────┘
//
// THE DATE RANGE (decision 2A) drives the Table (jobs overlapping it) and the
// Gantt (the days it draws); on the Calendar tab its start is the anchor and
// the view mode decides the window from there. With no range picked the Table
// lists every job and the Gantt opens on two weeks from today.
//
// THE MOBILE SECTION IS THE POINT OF THE LAST TWO ROWS. The header cannot hold
// the line and machine pickers and the area picker on a phone — they wrap or
// overflow. Rather than hiding them there (which is what an earlier layout did
// to the area picker, silently making it unreachable), they are rendered HERE
// below `md`, where the sidebar is already a full-screen sheet. The user menu
// is not among them: it lives in the footer at every width, matching
// master-data. Every control stays reachable at every width; only its location
// moves.
//
// THERE IS NO RECURRING EVENTS BUTTON ANY MORE. Recurrence was removed with the
// maintenance event model this module was derived from; a job is a date range
// with a plan, and a "repeating job" is a new job.

// A full-width action. In ICON MODE it collapses to the icon alone and keeps its
// accessible name — the rail stays usable rather than becoming three unlabelled
// squares.
//
// `unavailable` is a real `disabled` plus a tooltip that SAYS WHY, and the two
// travel together on purpose: a greyed-out control with no explanation is read
// as a permission problem, and the operator goes looking for an admin instead of
// waiting for a release. `SidebarProvider` already mounts a `TooltipProvider`,
// so the trigger here needs no extra wrapper. Nothing passes it today — Create
// Job shipped — but the next deferred action will, and the tooltip wiring is the
// part that is easy to get wrong.
function SidebarAction({
  icon: Icon,
  label,
  onClick,
  variant = "outline",
  unavailable,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: "default" | "outline";
  unavailable?: string;
}) {
  const button = (
    <Button
      variant={variant}
      onClick={onClick}
      disabled={unavailable !== undefined}
      aria-label={label}
      title={unavailable === undefined ? label : undefined}
      className="w-full justify-center group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
    >
      <Icon />
      <span className="group-data-[collapsible=icon]:hidden">{label}</span>
    </Button>
  );

  if (unavailable === undefined) return button;

  // A disabled button fires no pointer events, so the trigger wraps it in a span
  // — without that the tooltip never opens and the explanation is unreachable,
  // which is the whole failure this branch exists to avoid.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block w-full">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="right">{unavailable}</TooltipContent>
    </Tooltip>
  );
}

function AppSidebar() {
  const { t } = useTranslation("jobs");
  const { anchor, range, setSearch } = useCalendarSearch();
  const { openCreate, openActivity } = useCalendarChrome();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <AppSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="gap-3">
          <SidebarAction
            icon={CalendarPlusIcon}
            label={t("sidebar.createJob")}
            onClick={openCreate}
            variant="default"
          />

          {/* Hidden in icon mode: a month grid cannot survive a 3rem rail, and
              shrinking it to fit would make every date a 4px target. */}
          <div className="space-y-1 group-data-[collapsible=icon]:hidden">
            {/* The range in WORDS, above the grid, because a range that starts
                in another month has one end the grid is not showing. */}
            <div className="flex min-h-7 items-center justify-between gap-2 text-xs">
              <span className={range === undefined ? "text-muted-foreground" : "font-medium"}>
                {range === undefined
                  ? t("sidebar.noDateRange")
                  : formatCivilRange(range.from, range.to)}
              </span>
              {range !== undefined ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setSearch({ from: undefined, to: undefined })}
                >
                  {t("common.clear")}
                </Button>
              ) : null}
            </div>
            {/* NO view mode. The switcher drives the calendar in the body; this
                picks the range the tabs read. See its header. */}
            <MiniCalendar
              mode="range"
              range={range}
              fallback={anchor}
              timeZone={PLANT_TIME_ZONE}
              onRangePick={(next) => setSearch({ from: next.from, to: next.to })}
            />
          </div>
        </SidebarGroup>

        <SidebarSeparator className="mx-0" />

        <SidebarGroup className="gap-2">
          <SidebarAction
            icon={ScrollTextIcon}
            label={t("sidebar.logActivity")}
            onClick={openActivity}
          />
        </SidebarGroup>

        {/* MOBILE ONLY. See the header note: below `md` the app header has no
            room for these, and hiding them there would make the area picker
            unreachable rather than merely relocated. */}
        <div className="md:hidden">
          <SidebarSeparator className="mx-0" />
          <SidebarGroup className="gap-3">
            <JobFilters stacked />
            <div className="flex items-center gap-1">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
            <AreaSelect className="w-full" />
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}

export { AppSidebar };
