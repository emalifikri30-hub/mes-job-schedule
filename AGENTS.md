# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`CLAUDE.md` is a symlink to `AGENTS.md` — one file, both agents. Edit either; it is the same bytes.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Commands

```bash
pnpm install                        # or vp install
pnpm dev:all                        # web :3000, bff :3001, api :3002
pnpm dev:web | dev:bff | dev:api    # one app
pnpm run ready                      # vp check && vp run -r test && vp run -r build (pre-push gate)

vp check                            # format + lint + type-check, whole repo
vp run -r test                      # test every package
pnpm --filter <app> run check|test|build
pnpm --filter api db:migrate        # apply the job_schedule schema (needs JOB_SCHEDULE_DATABASE_URL)
```

**One test file / one test name** — vitest positional filters pass straight through:

```bash
pnpm --filter web exec vp test job-plan-csv     # runs src/lib/job-plan-csv.test.ts
pnpm --filter api exec vp test job-service
pnpm --filter web exec vp test watch            # vp test does NOT watch by default
```

**Type-aware lint needs the workspace packages built first.** `packages/*/dist` is gitignored, and
`vp check` resolves `@molca/*` types from those built outputs. On a fresh checkout, or after
changing a package, run `pnpm --filter "<app>^..." run build` before `pnpm --filter <app> run check`
(this is exactly what `api` and `bff` CI does). `web` is the exception — it depends on no workspace
package, so `web^...` resolves to nothing and its CI check job has no prebuild step.

**`@molca/mes` is a private `git+ssh` dependency** (`molca-id/mes-shared`). `pnpm install` needs an
SSH agent with access; CI loads `MES_SHARED_DEPLOY_KEY`. It supplies auth: `createAuthMiddleware`,
`createKeycloakJwks`, `createServiceTokenProvider`, `bearerToken`/`cookieToken`, and the `AuthEnv`
Hono type. Auth is tested there, not here — handler tests stub `authMw` with a pass-through.

## What this module is

A **job schedule**: production jobs planned against lines and machines. A job is a date range, a
header (Roll Yield, Bag Yield, WD Today, RW/TW personel, overtime per shift and its unit, notes),
the people responsible (Managers, Foreman, AFA — Keycloak users) and a **plan** uploaded as CSV: one
row per `(date, line, machine, SKU, target, shift 1/2/3)`. It renders in three tabs — **Calendar**
(default), **Table** and **Gantt** — filtered by a date range, lines and machines, with a full audit
trail in "Log Activity".

```
 web (React SPA, nginx) → bff (Hono, OIDC + session cookie) → api (Hono, modular monolith)
                                                                 ├─→ PostgreSQL, `job_schedule` schema
                                                                 ├─→ mes-master-data (separate repo)
                                                                 └─→ Keycloak admin API (role members)
```

The browser never holds a token: it talks to the BFF same-origin, and `/api/proxy/*` swaps the
httpOnly cookie for a bearer token toward `api`. Each app has its own README with env vars.

**Not built yet, deliberately** (TODOS.md): deleting a job, configurable shifts, and
plan-vs-actual.

### The decisions the whole design rests on

Each has a cheaper-looking alternative that is wrong in a way no test failure would name.

1. **Plan dates and shifts are WALL-CLOCK; instants are built only on the server.** A plan row
   stores a business date and three shift flags. Shift boundaries are hardcoded in
   `apps/api/src/shared/shift.ts` (S1 07–15, S2 15–23, S3 23–07 **next day**) and are turned into
   instants in the job's IANA `time_zone` there and nowhere else. The browser receives finished
   `startsAt`/`endsAt`. **The test suites run in `America/New_York`** (both `vite.config.ts` files)
   so a "just add 7 hours" bug fails in CI rather than in a plant.

2. **The plan is stored as the planner wrote it** — one row per `(date, machine, SKU)` with ONE
   `target` and three shift flags — not exploded per shift. The target is the DAY's quantity across
   every ticked shift and is never divided between shifts anywhere; that is why a Calendar block
   shows counts, not a target, and why a Gantt bar takes a row's target once, in the bar holding the
   row's FIRST ticked shift (`web/src/lib/gantt-bars.ts`).

3. **A target's unit is the machine's FINISH-GOOD unit** — the `uom` of its `good_output` count
   point in mes-master-data, frozen onto the row. Master-data SKUs only carry a base unit; this is
   the output-side unit mes-oee-monitor reports `good_out` in (its contract §16.4), which is what
   will make plan-vs-actual comparable. NULL when the machine has none, or when its good_output
   points disagree — then the number renders bare, never under a guessed unit. **Totals are summed
   per SKU per unit and never across units.**

4. **One `resolve()` behind preview, create and update.** The browser checks CSV syntax only; the
   server resolves names against master data (line by name across areas, machine by name ON that
   line, SKU by **code** — names are not unique — finish-good unit, people hold their role, no
   duplicate row, no other job's slot). `POST /jobs/preview` writes nothing and shows exactly what
   Save would write; Save re-resolves rather than trusting the preview, and a refused save answers
   with the preview's own shape (`{ data: PlanPreview, error }`, 400 or 409).

5. **A machine, date and shift belong to at most one job**, checked under a transaction-scoped
   advisory lock (`job-repository.ts`). It is not expressible as a constraint over three boolean
   columns, so it is a check-then-write, and without the lock two overlapping saves both commit. The
   integration suite races two saves to prove exactly one wins.

6. **Windows and answers are both capped, and truncation is never silent.** The Calendar read takes
   at most 400 days, the Gantt read 31 (the browser clips its range and says so); each answer has a
   row cap and `truncated: true` travels in the payload.

Names (line, machine, SKU, person) are **frozen at write time** throughout: a renamed line must not
relabel a plan somebody approved.

### `api` — module layout

`src/module/<feature>/` is one vertical slice: `<feature>.ts` (domain types) · `-dto.ts` (Zod) ·
`-handler.ts` (Hono routes) · `-service.ts` (orchestration, metrics, error mapping) ·
`-repository.ts` (SQL) · `-module.ts` (Awilix). `job` is the only slice with tables. `user` reads
Keycloak's admin API (`keycloak-user-client.ts`, cached in `user-service.ts`). `master-data` reads
an upstream service instead, so its "repository" is `-client.ts` behind `-schema.ts` plus
`-error.ts` and `time-zone-resolver.ts`. `health` has neither.

Wiring: `src/cmd/container/container.ts` builds the Awilix container in **PROXY mode with
`strict: true`** — every name a constructor destructures must appear in the `Cradle` type _and_ be
registered, or it throws at resolve time rather than at boot. `src/cmd/api/app.ts` mounts handlers
under `/api/v1` and owns the global error mapping.

Endpoints — `/health/{liveness,readiness}`, and under `/api/v1`:

- `jobs` — `GET /` (Table: summaries, `page`/`size`, `PageMeta`), `GET /shifts` (Calendar: one
  block per job × business date × shift), `GET /plan` (Gantt: plan rows, ≤ 31 days),
  `GET /activity`, `POST /preview`, `GET /:id`, `POST /`, `PUT /:id`. Three reads of the same rows
  **on purpose**: the Table must not carry 560 plan rows per job to draw four columns, and a flag on
  one endpoint would make every caller's response a union. Array filters cross the query string
  comma-separated (`workCenterIds=1,2`). An edit's preview passes `?jobId=` so the job's own rows
  are not conflicts with itself.
- `users?role=MANAGER|FOREMAN|AFA` — members of the realm role configured by `JOB_*_ROLE`. The query
  names the JOB role, never a realm role, so the route cannot be used to list arbitrary roles.
  Failures are worded for their owner ("role … not found in the realm", "service account lacks
  view-users", "user directory unavailable") and are **never an empty list** — "nobody holds this
  role" and "could not ask" look identical in a picker.
- `master-data/{areas,work-centers,work-units,products,…}` — cached reference lists from
  mes-master-data, served stale on an upstream outage.

**There is no DELETE yet** (TODOS §8), and **no write route for the audit trail**, by design:
entries are written by the mutations themselves, inside their own transactions. An endpoint that
let a caller append to the log would let a caller forge it.

**Schema.** `0003_job_plan.sql` dropped the maintenance-derived `events`/`event_targets` and created
`jobs`, `job_people` and `job_plan_items`. `0001`/`0002` are not edited — the ledger is keyed by
filename, so an edited applied migration is silently skipped everywhere it already ran.

### The audit trail

`job_schedule.activity_log`, surfaced as "Log Activity" in the sidebar. Three decisions carry it:

1. **`ON DELETE SET NULL`, never `CASCADE`.** `job_people` and `job_plan_items` cascade because they
   are part of the job; an audit row is the opposite — it is the record that the job existed.
   `job_label` ("Job #12 · 01 Oct 2026 – 10 Oct 2026") is therefore denormalised onto the log, and
   the feed never joins back to `jobs`.
2. **The diff is computed and WORDED at write time** (`job/activity-diff.ts`) — "Roll yield",
   "95%" → "97%". The plan is summarised ("560 rows · 3 lines · 12 machines"), not diffed cell by
   cell, and is only reported when its order-independent fingerprint moved.
3. **`changes` is NULL for a create or a delete, and an empty diff writes no row at all.** NULL
   means "there is no before"; `[]` would claim nothing changed.

`changes` crosses the driver as **text in both directions**. Writing uses `sql.json()`, not
`JSON.stringify(...)::jsonb`: postgres.js encodes the parameter itself, so pre-stringifying encodes
twice and the column silently ends up holding a jsonb _string_. Reading selects `changes::text` and
parses in one place. The same `sql.json()` rule applies to the conflict query's candidate cells.

### Rules the server enforces that a browser cannot

Each of these, if skipped, writes a row that renders correctly and means something wrong:

| Rule                                                            | What goes wrong without it                        |
| --------------------------------------------------------------- | ------------------------------------------------- |
| every machine is on its row's line (by name, unambiguous)       | production planned on somebody else's equipment   |
| the SKU is matched by CODE and assigned to that line            | the wrong product planned under a shared name     |
| every chosen person holds the realm role for their slot         | anybody in the realm named as a job's manager     |
| no machine-date-shift already held by another job (under lock)  | two plans for one slot, targets double-counted    |
| `created_by_id` comes from the verified token, never the body   | a plan attributed to a person who did not make it |
| overtime and its unit together; percentages 0–100; range ≤ 62 d | a number that means two different things          |

The last row is **also** CHECK constraints on `jobs`, and "at least one shift ticked" is a CHECK on
`job_plan_items`. Both, not either: the dto is the good error message, the constraint is the
guarantee.

### `web` — SPA conventions

File-based TanStack Router under `src/routes/`; `src/routeTree.gen.ts` **is committed and must never
be hand-edited** (CI asserts freshness with `git diff --exit-code`). `_app.tsx` is the pathless
authenticated shell — `beforeLoad: requireAuth` gates the whole subtree, so there is no
`<RequireAuth>` component. `/` redirects to `/calendar`, which renders the three tabs.

- All server data flows through `src/lib/api.ts` (axios, `PROXY_PREFIX = /api/proxy/api/v1`),
  `src/lib/queries.ts` (reads) and `src/lib/mutations.ts` (writes). **Nothing in a route loader may
  import a mutation**; the split is what makes that structural rather than a review comment.
- `login()`/`logout()` must stay full-page `location.href` navigations — those endpoints answer with
  cross-origin 302s a client-side navigation cannot follow. Where login may _return_ to is
  allow-listed separately by `ALLOWED_PREFIXES` in `apps/bff/src/module/auth/auth-service.ts`; a
  path missing there is silently rewritten to `/`.
- **Every piece of view state is in the URL**, and `lib/calendar-search.ts` is the one place that
  parses and writes it: `tab` (calendar | table | gantt, default calendar), `view` and `date` (the
  Calendar's view mode and anchor), `from`/`to` (the sidebar's date range — **inclusive** in the
  URL; `rangeWindow()` in `calendar-window.ts` is the one conversion to the half-open window the
  api takes), `lines`/`machines` (arrays), `page`/`size` (Table). Defaults are applied when the
  component READS the search, so `/calendar` stays a valid link. Any change but a page change
  resets `page`; clearing lines clears machines.
- **`useCalendarSearch` reads the LOCATION, not the match.** The sidebar and header are mounted by
  `_app`, which has no `validateSearch`, so `useSearch({ strict: false })` handed them an empty
  object — every control above the route was blind to the URL while the route itself worked.
- **The date range drives Table and Gantt; the Calendar pages from its own anchor** (`date ?? from ??
today`) with its view mode deciding the window. Picking a range clears `date`. The Gantt with no
  range opens on 14 days from today and clips any range to 31 days with a banner.
- **Filters:** date range in the sidebar (`MiniCalendar` has a range mode); Lines and Machines
  multi-selects in the header (`components/job/job-filters.tsx`), machine options being the union of
  the selected lines' rosters (`useQueries` over the per-line endpoint). The header's right-hand
  controls RELOCATE into the sidebar below `md` rather than disappearing.
- **The grid is ALWAYS rendered** — never replaced by a message, least of all when the window is
  empty. A calendar with nothing planned is a calendar with empty days; a Gantt with nothing planned
  still draws its day/shift header. Loading and error are banners over it.
- **A click opens the READ-ONLY job detail, never the edit form** — the Table's Detail icon, a
  Calendar block and a Gantt bar all call `openDetail(jobId, date?)` in `calendar-chrome.tsx`; a
  block or bar opens it on its own business date. Edit is a separate, deliberate button (the Table's
  pencil, or the detail's own Edit). The detail (`components/job/job-detail-sheet.tsx` over the pure
  `lib/job-detail.ts`) groups the plan **by date**, then line, then machine, because the Table shows
  a job as a range; totals are per SKU per unit, and each target's bar is scaled within its (day,
  line, unit) — never across units. Calendar blocks are one per job × business date × shift,
  showing line/machine/SKU counts. **S3 draws on both days** — 23:00–24:00 on its business date and
  00:00–07:00 on the next — because `occursOn` in `layout-occurrences.ts` also matches the day
  `endsAt` falls on (exclusive, in the block's zone). The Year view's click-a-date (navigation, not
  detail) stays.
- **Six calendar views, THREE renderers, under the Calendar tab.** `TimeGrid(days)` serves Day /
  4 Days / Week and takes no mode flag; `DateGrid` serves Month and Year and _does_ branch, because
  the Year view renders a dot per day with something on it, not blocks. `AgendaList` is the Schedule
  view. The Table (`components/job/job-table.tsx`) copies mes-oee-monitor's `DataTable` +
  `TablePagination` + `indexColumn` (`components/table/*`, `lib/table.ts`); the Gantt is
  `components/job/gantt-view.tsx` over the pure `lib/gantt-bars.ts`.
- **The job dialog** (`components/job/job-dialog.tsx`, opened by the sidebar's Create Job and the
  Table's Edit) is three steps: Details → Plan → Confirm. The CSV template
  (`date;line;sku;sku_code;target;machine;shift1;shift2;shift3`, `;`, UTF-8 BOM, DD/MM/YYYY, `v` or
  blank) is BUILT in the browser from the chosen lines' machines × products × the job's dates
  (`lib/job-plan-csv.ts`); an upload is syntax-checked there and resolved by `POST /jobs/preview`.
  Edit prefills everything, offers "Download current plan", and a re-upload replaces the plan.
- **`lib/calendar-window.ts` is the only thing that answers "which dates are on screen,"** and
  **`lib/civil-date.ts` is the only thing that does date arithmetic in the browser** (UTC fields
  only — exact for calendar arithmetic, useless for building a wall-clock instant, which is the
  point).
- `src/components/ui/*` are repo-owned shadcn files — edit them freely. Style with semantic tokens
  (`bg-background`, `text-muted-foreground`), never hardcoded palette colors, or dark mode breaks.

## CI and observability

Per-app workflows in `.github/workflows/`, path-filtered, each `install-deps → {check, test, build}
→ release-image`. Every job needs the `MES_SHARED_DEPLOY_KEY` secret to fetch `@molca/mes`, image
builds included. `release-image` runs only on push to `main`.

- `api`'s test job starts a **`postgres:18-alpine`** service and sets `JOB_SCHEDULE_TEST_DATABASE_URL`,
  so the integration suite always runs there, against the checked-in DDL applied by the real
  `scripts/migrate.mjs`.
- `web`'s **build** job asserts `routeTree.gen.ts` freshness with `git diff --exit-code`; `tsc -b`
  alone would not catch a stale tree.

`apps/api/src/shared/observability/metrics.ts` annotates every instrument with the PromQL that
should page somebody, and those annotations are real rules in `prometheus-alerts.yml` with a
provisioned dashboard at `grafana/dashboards/job-schedule-service.json`. **Keep the three in step** —
and note a histogram exports as `_bucket`/`_count`/`_sum` while a counter keeps its name exactly.
Grafana is deliberately not editable in the UI (a clicked-together dashboard is lost on restart and
is not reviewable); change the JSON. `docker compose up` brings up the whole chain — Jaeger :16686,
Prometheus :9090, Grafana :3005 (not 3000, which `web` owns in dev). Nothing routes a firing alert
anywhere yet (TODOS.md).

## Testing conventions

- **`api` unit tests** use a hand-rolled fake or plain `vi.fn()` deps. Outbound HTTP is stubbed with
  `msw/node`.
- **`api` integration tests** (`*.integration.test.ts`) run against a real Postgres and are
  **skipped unless `JOB_SCHEDULE_TEST_DATABASE_URL` is set**, so `vp test` stays green without
  Docker. CI always runs them. They exist because a fake `sql` returns whatever the test author
  typed and therefore agrees with the code by construction — the two bugs they caught during the
  initial build were an INSERT that never set `created_by_id` (a NOT NULL violation on the very
  first save) and every `bigint` id coming back as a **string**, which matches the domain type in
  TypeScript's eyes and in nobody else's. Every bigint is cast with `::int` in the SELECT for that
  reason.
- **`web`** runs `happy-dom`. Pure arithmetic and time-zone logic belongs in `src/lib/*.ts` with a
  colocated test; component tests exist for the one thing a pure function cannot reach — _which
  state a component selects_ (pending / error / empty / populated, plus the trap that a query gated
  by `enabled: false` reports `status: "pending"` forever). Render through `src/test/render.tsx`,
  which supplies a fresh QueryClient, router stubs, providers **and `afterEach(cleanup)`** — without
  that last one every render stacks into one `document.body` and assertions fail with "found
  multiple elements" naming a component that is correct.
- **Both suites run under `TZ=America/New_York`.** `tz-guard.test.ts` in each app asserts that the
  process is in a zone that observes DST, so a later "cleanup" of that config fails loudly instead
  of silently weakening every date test in the repo.

## Conventions

- Conventional commits with an app scope: `feat(web):`, `feat(api):`, `fix(web):`, `docs:`.
- **`TODOS.md` is the durable backlog** and part of the workflow, not a scratch file: entries carry
  enough context to pick up cold, are numbered (`§1`), and commits close them explicitly. Deferred
  work belongs there rather than being done in passing.
- Comments in this codebase explain _why_, often at length, and frequently point at the failure that
  motivated the code. Match that register; when you change code with a nearby explanation or ASCII
  diagram, update it in the same change — a stale one actively misleads.
- Package versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: prefer`); add new deps
  as `catalog:` entries. `@tanstack/react-router` and `@tanstack/router-plugin` must be bumped
  together.
- **Every object in every migration is schema-qualified**, and the migration ledger lives at
  `job_schedule.schema_migrations`. This database is shared with mes-oee-monitor's `oee` schema; the
  header in `apps/api/scripts/migrate.mjs` explains what an unqualified ledger costs when two
  repos derived from one template share a database.

## Derived from mes-schedule-maintenance

The whole repo was copied from `../mes-schedule-maintenance`, which was itself derived from
`../mes-oee-monitor`. The copy was taken for its LAYOUT, THEME and MECHANISM, and the rename was
mechanical: `maintenance` → `job`, the `maintenance` schema → `job_schedule`, `/api/v1/job-events` (since replaced by `/api/v1/jobs`),
`JOB_SCHEDULE_DATABASE_URL`.

**A mechanical rename leaves prose that is technically renamed and substantively wrong.** The
comments here are unusually specific about WHY a decision was made, and a sentence explaining a
maintenance decision does not become a job decision by having its nouns swapped. Two kinds to watch
for, and to DELETE rather than update when you find one:

- rationale that only holds for maintenance — anything resting on the stop being PLANNED downtime,
  or on a window being subtracted from loading time;
- a `PM` in an ASCII diagram or an example, which is a preventive-maintenance abbreviation that
  survived as a short label.

The same rule the maintenance repo inherited applies again: a confident explanation of a decision
made in a different product is exactly the "stale diagram" failure this codebase's comment style
exists to prevent.
