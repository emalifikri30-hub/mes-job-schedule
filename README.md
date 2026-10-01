# mes-job-schedule

Scheduled **production jobs** for the MES suite: a date range, its yields, personnel and people,
and a **plan** uploaded as CSV — which SKU runs on which machine, on which date, in which of the three
shifts, towards what target. Shown as a Calendar (default), a Table and a Gantt.

The module was copied from [`mes-schedule-maintenance`](../mes-schedule-maintenance) for its layout,
theme and mechanism; the data model is its own (`apps/api/src/shared/database/migration/0003_job_plan.sql`).
Deliberately not built yet: deleting a job, configurable shifts, plan-vs-actual —
see [TODOS.md](TODOS.md).

```
  browser                 bff (:3001)                 api (:3002)              upstream
  ───────                 ───────────                 ───────────              ────────
  web SPA  ──same-origin──▶ OIDC + httpOnly cookie
  /calendar                 /api/login /api/callback
                            /api/me /api/token/refresh
           ──/api/proxy/*──▶ cookie → Bearer  ────────▶ /api/v1/jobs, /api/v1/users
                                                              │
                                                              ├──▶ Keycloak admin API
                                                              │      (members of the job roles)
                                                              ├──▶ PostgreSQL
                                                              │      schema: job_schedule
                                                              │
                                                              └──▶ /api/v1/master-data/*
                                                                     ──▶ mes-master-data
```

The browser never holds a token. `web` talks only to the BFF, same-origin; the BFF owns the session
cookie and swaps it for a bearer token on the way to `api`.

## Quick start

```bash
pnpm install                     # needs an SSH agent with access to molca-id/mes-shared
cp apps/api/.env.example apps/api/.env
cp apps/bff/.env.example apps/bff/.env   # fill in your own OIDC client and cookie secret
pnpm --filter api db:migrate     # applies the job_schedule schema
# api also needs JOB_MANAGER_ROLE / JOB_FOREMAN_ROLE / JOB_AFA_ROLE and a service account
# allowed to list realm users — see apps/api/README.md
pnpm dev:all                     # web :3000, bff :3001, api :3002
```

Then open <http://localhost:3000> — it redirects to `/calendar`.

## Onboarding: from zero to running locally

The step-by-step version of the quick start above, for a developer setting this repo up for the
first time.

### 1. Prerequisites

| Tool / access               | Version / detail                                                                   | Check                                  |
| --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| **Node.js**                 | `>=22.12.0`                                                                        | `node -v`                              |
| **pnpm**                    | `11.8.0`, pinned via `packageManager` — run `corepack enable` once                 | `pnpm -v`                              |
| **Git + SSH key on GitHub** | Your key must have read access to `molca-id/mes-shared` (the `@molca/mes` package) | `ssh -T git@github.com`                |
| **Docker**                  | For a local Postgres and the optional observability stack                          | `docker version`                       |
| **Keycloak access**         | A realm, two clients and three realm roles — ask the team lead (see below)         | —                                      |
| **mes-master-data**         | A reachable instance for the line / machine / SKU pickers                          | shared dev URL, or run it locally (§6) |
| `psql` _(optional)_         | Handy for inspecting the database                                                  | `psql --version`                       |

The [Vite+](https://viteplus.dev) `vp` CLI is a dev dependency — `pnpm install` brings it, nothing
to install globally.

**Keycloak setup you need:**

- **BFF client** (`apps/bff/.env` → `OIDC_CLIENT_ID`): a _confidential_ client with
  `http://localhost:3001/api/callback` registered as a Valid Redirect URI.
- **api client** (`apps/api/.env` → `OIDC_CLIENT_ID`): a client with **service accounts enabled**.
  It calls mes-master-data, and it lists users for the people pickers through Keycloak's admin
  API — so its service-account user needs the `realm-management` client roles **`view-users`**
  and **`view-realm`**.
- **Three realm roles** for the Manager / Foreman / AFA pickers (`JOB_MANAGER_ROLE`,
  `JOB_FOREMAN_ROLE`, `JOB_AFA_ROLE`), with a few users in each so the pickers have something to
  show.

### 2. Clone and install

```bash
git clone <repo-url> mes-job-schedule    # SSH URL from GitHub
cd mes-job-schedule
corepack enable
pnpm install
pnpm --filter "./packages/*" run build   # build the shared @molca/* packages once
```

The last line matters on a fresh checkout: `packages/*` export from their `dist/`, which is
gitignored, so `pnpm dev:api` / `pnpm dev:bff` and `vp check` cannot resolve `@molca/*` until it
has been built. Re-run it after pulling changes to a package.

If `pnpm install` fails on `git+ssh://git@github.com/molca-id/mes-shared.git`, your SSH key either
is not loaded (`ssh-add -l`) or has no access to that repo — ask for access before going further.

### 3. Start a local Postgres

```bash
docker run -d --name job-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=job_schedule \
  -p 5432:5432 postgres:18-alpine
```

Port `5432` already taken? Map another one (`-p 55432:5432`) and use it in the URL below. Pointing
at the shared dev database instead is fine — but it is shared, so double-check before migrating.

### 4. Create the `.env` files

```bash
cp apps/api/.env.example apps/api/.env
cp apps/bff/.env.example apps/bff/.env
printf 'PORT=3000\nBFF_URL=http://localhost:3001\n' > apps/web/.env
```

**About `apps/web/.env`:** without it the web dev server listens on **:3100** and proxies to a BFF
on **:3101** (so this repo can run next to the others), while the BFF example listens on :3001.
The file above lines web up with the `.env.example` values. To use 3100/3101 instead, set the BFF's
`PORT`, `OIDC_REDIRECT_URI`, `CLIENT_BASE_REDIRECT_URI` and `CORS_ALLOWED_ORIGINS` to match, and
register the new redirect URI in Keycloak.

Then fill in at least:

| File            | Variable                                                          | Value                                                      |
| --------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/api/.env` | `JOB_SCHEDULE_DATABASE_URL`                                       | `postgres://postgres:postgres@localhost:5432/job_schedule` |
| `apps/api/.env` | `OIDC_HOST`, `OIDC_BASE_URI`, `OIDC_TOKEN_URI`, `KEYCLOAK_REALMS` | Your realm                                                 |
| `apps/api/.env` | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                            | The **api** (service-account) client                       |
| `apps/api/.env` | `JOB_MANAGER_ROLE`, `JOB_FOREMAN_ROLE`, `JOB_AFA_ROLE`            | Realm role names that exist in your realm                  |
| `apps/api/.env` | `MASTER_DATA_BASE_URL`                                            | A reachable mes-master-data api — **not** `:3002`          |
| `apps/bff/.env` | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_BASE_URI`           | The **BFF** client and your realm                          |
| `apps/bff/.env` | `COOKIE_SECRET`                                                   | Output of `openssl rand -base64 32`                        |

Everything else in the examples already works for local development. Leave the opt-in variables
(`AUTH_AUDIENCE`, `AUTH_ALLOWED_AZP`, `*_EVENT_ROLE`) unset. `.env` files are gitignored — never
commit them.

### 5. Apply the schema

```bash
pnpm --filter api db:migrate
```

Creates the `job_schedule` schema (jobs, people, plan items, activity log). It is safe to re-run.

### 6. Run mes-master-data locally (only if there is no shared instance)

mes-master-data's api also defaults to port `3002`, so give it another one. In the
**mes-master-data** checkout, set `PORT=4002` in `apps/api/.env` and run only its api:

```bash
cd ../mes-master-data && pnpm dev:api     # listens on :4002
```

Then use `MASTER_DATA_BASE_URL=http://localhost:4002` here. See mes-master-data's README for
its own setup.

### 7. Start the apps

```bash
pnpm dev:all        # web :3000, bff :3001, api :3002 (with the apps/web/.env above)
# or, one per terminal:
pnpm dev:api
pnpm dev:bff
pnpm dev:web
```

### 8. Check that it works

- `curl http://localhost:3002/health/readiness` reports the database and Keycloak as up.
- <http://localhost:3000> sends you to the Keycloak login, then back to `/calendar`.
- In the "new job" dialog, the line / machine pickers list real records (mes-master-data is
  reachable) and the three people pickers list users (the Keycloak roles and admin permissions are
  right).
- `pnpm run ready` passes (check + test + build).

### Troubleshooting

| Symptom                                            | Likely cause                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Web is on :3100 and `/api/*` calls fail            | `apps/web/.env` is missing, so web proxies to :3101 where nothing listens — see step 4.              |
| `Port 3000/3001/3002 is already in use`            | A stale dev server. Ports are strict on purpose — kill the old process instead of changing ports.    |
| api refuses to boot listing a missing variable     | A required `.env` value is empty (the three `JOB_*_ROLE` have no default); compare with the example. |
| People pickers: "service account lacks view-users" | Grant `view-users` and `view-realm` (client `realm-management`) to the api client's service account. |
| People pickers: "role not found in realm"          | A `JOB_*_ROLE` names a role that does not exist in `KEYCLOAK_REALMS`.                                |
| Line / machine pickers return 502 or 404           | `MASTER_DATA_BASE_URL` is unreachable, or points at `:3002` (the api calling itself).                |
| Keycloak shows "Invalid redirect URI"              | `OIDC_REDIRECT_URI` is not registered on the BFF client exactly as written.                          |
| Every request 401s after login                     | The BFF and api point at different realms, or you set `AUTH_AUDIENCE` / `AUTH_ALLOWED_AZP`.          |

## Layout

| Path         | What it is                                                                        |
| ------------ | --------------------------------------------------------------------------------- |
| `apps/web`   | React SPA. TanStack Router + Query, Tailwind, shadcn/ui. Served by nginx in prod. |
| `apps/bff`   | Hono. OIDC login, the session cookie, and a hardened `/api/proxy/*`.              |
| `apps/api`   | Hono modular monolith. Owns the `job_schedule` schema; calls mes-master-data.     |
| `packages/*` | `contract-client`, `helper`, `network`, `observability`, `utils`.                 |

## The database

One schema, `job_schedule`, in the **same Postgres instance** that holds mes-oee-monitor's `oee`
schema:

```
  job_schedule.jobs ──1:N──▶ job_schedule.job_people        (MANAGER | FOREMAN | AFA, names frozen)
    start_date, end_date (inclusive), time_zone
    roll_yield, bag_yield, wd_today, rw/tw_personnel,
    overtime + overtime_unit, notes, created_by / updated_by
         │
         ├──────1:N──▶ job_schedule.job_plan_items    ONE CSV ROW EACH:
         │               plan_date (business date), line, machine, SKU (ids + names frozen),
         │               target, uom (the machine's finish-good unit), shift1/2/3
         │
         └── SET NULL ◀── job_schedule.activity_log   (the audit trail; outlives the job)
```

`activity_log`'s FK is **`ON DELETE SET NULL`, not `CASCADE`** — an audit row is the record that a job
existed, so a cascade would delete the evidence of a deletion. The job's label is denormalised onto
it for the same reason.

Because the instance is shared, **every object in every migration is schema-qualified** and the
migration ledger lives at `job_schedule.schema_migrations` rather than in `public`. The header in
`apps/api/scripts/migrate.mjs` explains what an unqualified ledger costs when two repos derived from
the same template share a database — the failure is a silently skipped migration.

## Shifts and the plan, briefly

Three hardcoded shifts — S1 07:00–15:00, S2 15:00–23:00, S3 23:00–07:00 the **next** day — stored as
wall-clock boundaries and turned into instants only in `apps/api/src/shared/shift.ts`. A plan row's
target is the day's quantity across its ticked shifts, in the machine's finish-good unit, and is
never split between shifts. A machine, date and shift can belong to only one job. See the decisions
in [`AGENTS.md`](AGENTS.md#the-decisions-the-whole-design-rests-on) before changing anything that
touches a date, a unit or the plan.

## Tests

```bash
pnpm run ready                   # check + test + build, the pre-push gate
pnpm --filter api exec vp test   # unit only; integration is skipped without a database
```

The integration suite needs a Postgres:

```bash
docker run --rm -d --name job-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=job_schedule -p 55432:5432 postgres:18-alpine
export JOB_SCHEDULE_DATABASE_URL=postgres://postgres:postgres@localhost:55432/job_schedule
export JOB_SCHEDULE_TEST_DATABASE_URL=$JOB_SCHEDULE_DATABASE_URL
node apps/api/scripts/migrate.mjs
pnpm --filter api exec vp test integration
```

**Both suites run under `TZ=America/New_York`**, deliberately. Indonesian zones have no DST, so a
date bug of the form "assumed the process's local zone" cannot fail on a developer's machine, on a
Jakarta server, or under the UTC a CI runner would otherwise default to. A `tz-guard.test.ts` in each
app asserts the process really is in a DST-observing zone, so removing that config fails loudly
instead of silently weakening every other date test.

## Observability

`docker compose up` brings up the whole chain: Jaeger :16686, Prometheus :9090, Grafana :3005 (not
3000, which `web` owns in dev).

Every instrument in `apps/api/src/shared/observability/metrics.ts` carries the PromQL that should
page somebody; those are real rules in `prometheus-alerts.yml`, drawn by
`grafana/dashboards/job-schedule-service.json`. Keep the three in step. Grafana is provisioned
read-only on purpose — a dashboard clicked together in the UI is lost on restart and cannot be
reviewed.

Nothing routes a firing alert anywhere yet — see [TODOS.md](TODOS.md) §5.

## CI / Docker Hub

Per-app workflows in `.github/workflows/`, path-filtered. Every job needs the repo secret
`MES_SHARED_DEPLOY_KEY` (a read-only deploy key on `molca-id/mes-shared`) to fetch `@molca/mes`,
image builds included. `release-image` runs only on push to `main` and needs
`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` and the repo variable `DOCKERHUB_NAMESPACE`.

## Derived from mes-schedule-maintenance

The whole repo was copied from `../mes-schedule-maintenance` — which took its monorepo template,
OIDC login flow, app shell and observability packages from `../mes-oee-monitor` before that. The
copy was taken for the layout, the theme and the mechanism; the rename to `job` / `job_schedule` was
mechanical, and a mechanical rename leaves prose that is renamed but not re-reasoned. The last
section of [`AGENTS.md`](AGENTS.md) says what to look for and to delete rather than update.
