# TODOs

Deferred work with enough context to pick up cold. Delete an entry when it ships.

Numbers are stable and are not reused: §0, §1, §2 and §4 were closed by the job-plan change (the job
form shipped; recurrence was removed, taking single-occurrence exceptions with it; one job per
machine-date-shift is now enforced under a lock; shift 3 is the overnight window and crosses midnight
by construction). §7 (job detail view) shipped as `components/job/job-detail-sheet.tsx`.

---

## 3. Role gating on create / update

**What:** Config-driven realm-role checks on the two job mutations (`POST /jobs`, `PUT /jobs/:id`).
The config keys are sketched in `apps/api/.env.example` (`CREATE_EVENT_ROLE`, `UPDATE_EVENT_ROLE` —
rename them to `CREATE_JOB_ROLE` / `UPDATE_JOB_ROLE` when this lands) and the metrics are already
defined (`operator_authorization_{grants,denials}_total`) with a rule in `prometheus-alerts.yml`.

**Why:** Any authenticated user can currently plan or re-plan plant-wide production. The wiring is
present and unused — `apps/api/src/shared/actor.ts` returns `roles` from the verified token and its
`RequiredRole` type exists precisely so a mutation can name one.

**Context:** Deferred because no role name was specified. Not to be confused with
`JOB_MANAGER_ROLE` / `JOB_FOREMAN_ROLE` / `JOB_AFA_ROLE`, which decide who may be NAMED on a job, not
who may save one. **Read the comment block in `actor.ts` before implementing**: the check MUST be
realm-scoped (`realm_access.roles`), not client-scoped. `resource_access[oidc.clientId]` looks like
the obvious source and is wrong — that client id is this service's own service account, so an
operator's browser token never carries it and the gate would 403 every user the moment it was
enabled.

**The rollout trap**, which is why the metrics exist: a role name Keycloak does not actually emit 403s
only the WRITE paths. Reads keep working, the calendar looks completely healthy, and the failure
surfaces the first time somebody tries to save a job. Set one role, have a real operator exercise
that one route, watch `operator_authorization_denials_total`, then set the next. `POST
/jobs/preview` writes nothing and should stay ungated, or a planner cannot even check a file.

**Depends on / blocked by:** somebody naming the realm roles in Keycloak. Add the config keys as
`parseOptional` so an unset role means "not gated" and enabling one is an env change, not a deploy.

---

## 5. Nothing routes a firing alert anywhere

**What:** `prometheus-alerts.yml` has its rules and `docker-compose.yml` has no Alertmanager, so every
one of them fires into a UI nobody is watching.

**Why:** Three of the rules describe conditions an operator would otherwise never learn about:
`ScheduleTruncated` means somebody was shown an incomplete schedule, `TimeZoneUnresolvable` means
writes are being refused, and `KeycloakUserDirectoryFailing` means the Create Job dialog's people
pickers are broken — usually an unprovisioned service account.

**Context:** Inherited from the template this repo was derived from, where the same gap exists. Needs
an Alertmanager service in compose, a receiver, and a decision about which rules are worth waking
somebody for — `severity: info` is already set on `ScheduleResponsesLarge` to mark it as not one of
them.

**Depends on / blocked by:** somewhere to send them.

---

## 6. Configurable shifts

**What:** Read shift boundaries from configuration (per plant or per line, most likely from
mes-master-data) instead of the three hardcoded in `apps/api/src/shared/shift.ts` (S1 07–15, S2
15–23, S3 23–07 next day) and mirrored as labels in the web.

**Why:** The requirement hardcodes them "for now". A plant on 06/14/22, or on two 12-hour shifts,
cannot be planned correctly today — its plan rows would draw at the wrong hours on the Calendar and
line up against the wrong shift in any plan-vs-actual comparison (§9).

**Context:** The storage is already shift-agnostic in the way that matters: `job_plan_items` stores
the shift NUMBER (`shift1/2/3` flags) and the business date, never an instant, so moving the
boundaries needs no migration of existing rows — only `shiftInstants()` changes, and it is the ONE
place in the api that turns a date into an instant. Two things do assume exactly three shifts and
would need widening for a two- or four-shift plant: the three boolean columns (a `smallint[]` or a
child table), and the CSV template's `shift1;shift2;shift3` columns. Decide whether a shift's
definition is frozen onto the job at write time (a plan approved under 07:00 keeps 07:00) or read
live — the codebase's rule elsewhere (names frozen at write) argues for frozen.

**Depends on / blocked by:** a source of truth for shift definitions. mes-oee-monitor also has shift
boundaries; they must agree (§9).

---

## 8. Delete job

**What:** A way to delete a job: `DELETE /api/v1/jobs/:id`, a service method, and a confirm step in
the UI (most naturally on the job detail sheet, `components/job/job-detail-sheet.tsx`).

**Why:** Not in the requirement, so not built. A job created by mistake can currently only be
re-planned, not removed, and its machine-date-shifts stay claimed against every other job (the
one-job-per-slot rule).

**Context:** The audit side is ready and was kept ready on purpose: `activity_log.action` already
allows `DELETED`, its FK to `jobs` is `ON DELETE SET NULL` (so the log outlives the job), and
`job_label` is frozen onto each entry so a deleted job still reads as "Job #12 · 01 Oct – 10 Oct
2026". `job_people` and `job_plan_items` cascade. The repository method should mirror `update`:
one transaction, the plan lock is NOT needed (a delete frees slots, it cannot create a conflict),
the audit row written inside it with `job_id` NULL from the start. Decide first whether a job whose
dates are in the past may be deleted at all — once plan-vs-actual (§9) exists, deleting a past plan
deletes what production was measured against.

**Depends on / blocked by:** a product decision on deleting past jobs.

---

## 9. Plan vs actual

**What:** Compare each plan row's `target` with what was actually produced — mes-oee-monitor's
`good_out` per machine, SKU, business date and shift.

**Why:** A plan is only useful if someone can see how production tracked it. That is the obvious
next question once jobs exist, and the data to answer it already exists in two services.

**Context:** The units were chosen so this is possible: a plan target is denominated in the machine's
FINISH-GOOD unit (the `uom` of its `good_output` count point in mes-master-data, frozen onto
`job_plan_items.uom_code`), which is the same output-side unit mes-oee-monitor reports `good_out`
in (its contract §16.4). Compare only where the codes match — a NULL or differing unit is "not
comparable", never a converted guess. mes-oee-monitor's `oee.work_unit_shift_reports` is keyed by
`(work_unit_id, business_date, shift)` and its product counts live in `oee.product_count_wc_*`.
Two pitfalls: a plan row's target covers ALL its ticked shifts (it is per day, not per shift — see
`job.ts`), so compare at the day grain or across the same set of shifts; and the shift boundaries
here and there must be the same definition (§6).

**Depends on / blocked by:** §6 agreeing with mes-oee-monitor's shift definition; an API on
mes-oee-monitor exposing per-SKU good_out at the needed grain.
