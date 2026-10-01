# api

The domain service: a Hono modular monolith that owns the **`job_schedule` schema**, calls
`mes-master-data` for line, machine, SKU and count-point records, and calls Keycloak's admin API
for the members of the three job people roles.

- **Port:** `3002`
- **Build output:** `dist/index.js` (deps externalized → needs `node_modules` at runtime)
- **Key routes:** `/health/{liveness,readiness}`, `/api/v1/jobs*`, `/api/v1/users`,
  `/api/v1/master-data/*`

## Environment

Copy `apps/api/.env.example` to `apps/api/.env`. Required (startup fails if missing):
`JOB_SCHEDULE_DATABASE_URL`, the five `OIDC_*` values, `KEYCLOAK_REALMS`, `REGION_CODE`,
`APPLICATION_ALIAS`, `MASTER_DATA_BASE_URL`, and `JOB_MANAGER_ROLE` / `JOB_FOREMAN_ROLE` /
`JOB_AFA_ROLE` (the realm roles the job dialog's people pickers list).

**Keycloak prerequisite.** The pickers read `GET /admin/realms/{realm}/roles/{role}/users` with this
service's own service account (`OIDC_CLIENT_ID`). Grant that client's service-account user the
`realm-management` roles **`view-users`** and **`view-realm`**, and create the three realm roles.
Until then the pickers show "service account lacks view-users" (and
`keycloak_requests_total{outcome="auth_error"}` rises); the rest of the dialog still works.

**One database, not the template's two.** There is no Silver tier here — this service reads no
telemetry, so a second pool would be a connection to a database nothing queries and a readiness
probe that could take the service out of rotation for an outage it does not care about.

## Migrations

```bash
pnpm --filter api db:migrate      # needs JOB_SCHEDULE_DATABASE_URL
```

`scripts/migrate.mjs` applies `src/shared/database/migration/*.sql` in filename order, each in its
own transaction with its bookkeeping row.

**The ledger is `job_schedule.schema_migrations`, and every object in every migration is
schema-qualified.** This is not style. The schema shares a Postgres instance with
mes-oee-monitor's `oee` schema, both repos descend from one template, and the template's runner
created a bare `schema_migrations` — which resolves to `public` and would be shared. The ledger is
keyed by FILENAME, so two template-derived repos shipping files with the same names would silently
SKIP each other's migrations: no error, no output, just a table that never got created. The runner's
header has the full account.

The first migration runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` (for the maintenance-era name
search, since removed). The migrating role needs CREATE on the database; on a managed instance where
that is not granted, have a superuser enable it once and the `IF NOT EXISTS` becomes a no-op.

`0001`/`0002` are the maintenance-derived schema as it was first deployed; **`0003_job_plan.sql`
drops `events`/`event_targets` and creates `jobs`, `job_people` and `job_plan_items`**, moving
`activity_log`'s FK onto `jobs`. The earlier files are not edited — the ledger is keyed by filename,
so an edited `0001` would be skipped by every database that already applied it.

## Module layout

`src/module/<feature>/` is one vertical slice: `<feature>.ts` (domain types) · `-dto.ts` (Zod) ·
`-handler.ts` (routes) · `-service.ts` (orchestration) · `-repository.ts` (SQL) · `-module.ts`
(Awilix).

- `job` — the only slice with tables. `job-service.ts` resolves an uploaded CSV plan against master
  data (one `resolve()` behind preview, create and update); `job-repository.ts` holds the plan lock
  that makes "one job per machine, date and shift" hold under concurrent saves.
  `shared/shift.ts` is **the only file in this service that turns a date into an instant**.
- `user` — the members of the three job realm roles, from Keycloak's admin API, cached with a
  last-known-good fallback. Also the server-side check that a chosen person holds their role.
- `master-data` — reads an upstream service, so its "repository" is `-client.ts` behind `-schema.ts`,
  with `-error.ts` and `time-zone-resolver.ts` beside it. Cached with a last-known-good fallback.
- `health` — no dto, no repository; its dependencies are `Probe`s.

Awilix runs in **PROXY mode with `strict: true`**: every name a constructor destructures must appear
in the `Cradle` type _and_ be registered, or it throws at resolve time rather than at boot.

## Tests

```bash
pnpm --filter api run test        # unit only without a database
```

Integration tests (`*.integration.test.ts`) are **skipped unless `JOB_SCHEDULE_TEST_DATABASE_URL` is
set**. CI always runs them against `postgres:18-alpine`, applying the checked-in DDL with the real
migrate script. Each file's header has the `docker run` command.

They earn their keep: the two bugs they caught during the initial build were an INSERT that never
set `created_by_id` (a NOT NULL violation on the very first save) and every `bigint` id coming back
as a **string**, which matches the domain type in TypeScript's eyes and in nobody else's. A fake
`sql` cannot see either, because it returns whatever the test author typed.

The suite runs under `TZ=America/New_York` — see the note in `vite.config.ts`.

## Docker

Built from the **repo root** (the build needs the workspace lockfile):

```bash
docker build -f apps/api/Dockerfile -t mes-job-schedule-api .
```

CI: `.github/workflows/api.yaml`.
