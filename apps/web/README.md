# web

The React SPA. One screen, `/calendar`, with three tabs: Calendar (default), Table, Gantt.

- **Dev port:** `3000` (Vite proxies `/api/*` to the BFF on `3001`)
- **Prod:** static build served by nginx; `BFF_UPSTREAM` points it at the BFF.

## Routes

| Path        | What                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| `/`         | redirects to `/calendar`                                                    |
| `/login`    | sign-in card; a sibling of the app shell, so it renders without the sidebar |
| `/calendar` | the three tabs, their filters, the job dialog and the activity drawer       |

A new top-level path segment must also be added to `ALLOWED_PREFIXES` in
`apps/bff/src/module/auth/auth-service.ts`, or signing in from a deep link silently lands on `/`.

`src/routeTree.gen.ts` **is committed and must never be hand-edited** — CI asserts its freshness
with `git diff --exit-code`, because `tsc -b` alone would not catch a stale tree.

## Where things live

```
src/lib/
  civil-date.ts         YYYY-MM-DD arithmetic. Parses into UTC and reads UTC fields ONLY,
                        which makes it exact for calendars and useless for building a
                        wall-clock instant — that is the point.
  calendar-search.ts    the URL contract + useCalendarSearch(). Read from the SIDEBAR
                        and the HEADER as well as the page, which is why it is a
                        module rather than route-local state.
  calendar-window.ts    (viewMode, anchor) -> {from, to, days}, and rangeWindow() for the
                        sidebar's inclusive range. THE ONLY answer to "which dates are on
                        screen".
  layout-occurrences.ts shift blocks -> positioned blocks. Overlap clustering; shift 3
                        draws on both of the days it touches.
  job-plan-csv.ts       the CSV template (built here) and the syntax check of an upload
  csv.ts                ';'-separated, BOM-aware parse/serialise (from mes-master-data)
  gantt-bars.ts         plan rows -> bars. Merge rule and the target-counted-once rule.
  plan-summary.ts       the Confirm step's per-date and per-SKU-per-unit totals
  job-detail.ts         the detail's grouping (date → line → machine) and bar scaling
  job-form.ts           the dialog's form state <-> the api body
  shift.ts              shift LABELS only — instants come from the server
  table.ts              pageWindow() + TanStack meta (from mes-oee-monitor)
  api.ts                axios calls. PROXY_PREFIX = /api/proxy/api/v1
  queries.ts            reads (queryOptions). NOTHING here writes.
  mutations.ts          writes. A route loader must never import this file.

src/components/calendar/
  calendar-view.tsx     navigation, the fetch, and WHICH renderer draws it
  time-grid.tsx         Day (1) / 4 Days (4) / Week (7) — one component, no mode flag
  date-grid.tsx         Month (blocks) / Year (dots) — one component, one real branch
  agenda-list.tsx       Schedule
  mini-calendar.tsx     the sidebar's picker — single date, or a RANGE for Table/Gantt.
                        It takes no view mode (see below)
  activity-drawer.tsx   the AUDIT TRAIL — who changed what, when

src/components/job/
  job-table.tsx         the Table tab (No · Date · Created By · Edit/Detail), server-paged
  gantt-view.tsx        the Gantt tab: line → machine rows, day → shift columns
  job-dialog.tsx        create AND edit: Details → Plan → Confirm
  job-detail-sheet.tsx  READ-ONLY detail: header figures + yield meters, people, the plan by
                        date → line → machine with totals per SKU per unit
  job-filters.tsx       Lines + Machines multi-selects (header; sidebar below md)

src/components/table/   DataTable, TablePagination, indexColumn — copied from mes-oee-monitor

src/components/layout/
  app-sidebar.tsx       logo · app switcher · Create Job · date picker · divider ·
                        Log Activity · (mobile) lines, machines, area, user
  app-header.tsx        title + breadcrumb, then lines · machines · divider ·
                        EN · area · user — all `hidden md:flex`
  calendar-chrome.tsx   owns the overlays (job dialog, activity drawer), so the sidebar
                        can open them
```

## The shell, and where controls live

The sidebar is a CONTROL PANEL, not a nav tree — this module has one screen, so a
nav of one row was a tree pretending to be a menu.

```
  ┌──────────────────────┬─────────────────────────────────────────────┐
  │ LOGO            [<]  │ Job Schedule  [Lines ▾][Machines ▾] │EN AREA👤│
  │ [Job Schedule     ▾] ├─────────────────────────────────────────────┤
  │ [ + Create Job     ] │ [Calendar] [Table] [Gantt]                  │
  │ ┌──────────────────┐ │                                             │
  │ │  date / range    │ │            the active tab, full width       │
  │ └──────────────────┘ │                                             │
  │ ──────────────────── │                                             │
  │ [ Log Activity     ] │                                             │
  └──────────────────────┴─────────────────────────────────────────────┘
```

**Below `md` the header's right-hand controls RELOCATE into the sidebar** rather
than disappearing. Hiding and relocating look identical in markup and are
opposite decisions: an earlier version hid the area picker below `sm` with
nowhere else to reach it, which made a control that scopes every line list
silently unavailable on a phone. Both ends carry a comment saying which one they
are doing, and `app-sidebar.test.tsx` asserts it.

## Three things the screens do that are easy to undo

**The grid is always on screen.** It is never swapped out for a message — not while loading, not on
error, and above all not when nothing is planned. A calendar with nothing planned is a calendar with
empty days; a Gantt with nothing planned still draws its day and shift header. Error and loading are
BANNERS over the grid. The exception is the Schedule view (and the Table), which are lists — an
empty list has no dates to keep.

**The view switcher drives the calendar in the BODY; the mini calendar picks the DATE.** They meet at
the anchor date and nowhere else. The mini calendar used to take the view mode and highlight every
date the main grid was showing — nonsense in Year, where it lit up all 365 days. `MiniCalendar`
takes no `viewMode`; its range mode is the sidebar's date-range filter for Table and Gantt, which is
a different thing from the calendar's window.

**A click opens the read-only detail, never the form.** The Table's Detail icon, a Calendar block
and a Gantt bar all open `JobDetailSheet` (a block or bar on its own day); Edit is its own button.
Looking is far more common than changing, and a form on click puts every glance one keystroke from
re-planning a job. The detail groups the plan by date because the Table shows a job as a range.

## Conventions

- **All view state is in the URL** — tab, view mode, anchor, date range, lines, machines, page. A filtered calendar is
  something people send each other, and the back button must undo a navigation rather than leave the
  page. Defaults are applied when the component READS the search params, so `/calendar` stays a
  valid link with no parameters.
- `src/components/ui/*` are repo-owned shadcn files — edit them freely. Style with semantic tokens
  (`bg-background`, `text-muted-foreground`), never hardcoded palette colors, or dark mode breaks.
- `login()`/`logout()` must stay full-page `location.href` navigations; those endpoints answer with
  cross-origin 302s a client-side navigation cannot follow.
- Times are rendered in **the job's own zone**, which the server sends on every shift block. Never
  the browser's.

## Tests

```bash
pnpm --filter web run test
pnpm --filter web exec vp test job-plan-csv   # one file
```

`happy-dom`. Pure logic lives in `src/lib/*.ts` with a colocated test; component tests cover the one
thing a pure function cannot reach — **which state a component selects** (pending / error / empty /
populated, plus the trap that a query gated by `enabled: false` reports `status: "pending"` forever).

Render through `src/test/render.tsx`. It supplies a fresh QueryClient, router stubs, the providers
**and `afterEach(cleanup)`** — without that last one every render stacks into one `document.body`
and assertions fail with "found multiple elements" naming a component that is perfectly correct.

The suite runs under `TZ=America/New_York`; `src/lib/tz-guard.test.ts` asserts that it really does.
