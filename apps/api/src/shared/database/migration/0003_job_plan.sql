-- THE JOB PLAN: what a job IS, replacing the maintenance-shaped series.
--
-- 0001 created `events` + `event_targets` — an RRULE series with a PLANNED
-- downtime reason, carried over from mes-schedule-maintenance so the calendar
-- had something to read. That shape was never agreed for a job (TODOS §0 as it
-- stood) and the tables were never written to: the create form was disabled in
-- every environment. They are dropped here rather than migrated because there is
-- nothing in them to migrate.
--
-- 0001 and 0002 are NOT edited. The ledger in scripts/migrate.mjs is keyed by
-- filename, so a rewritten 0001 would be skipped by every database that has
-- already applied it and those databases would keep the old tables forever.
--
-- Every object schema-qualified, for the reason 0001's header gives.
--
--   job_schedule.jobs ──1:N──▶ job_schedule.job_people       (who is responsible)
--          │
--          ├──────────1:N──▶ job_schedule.job_plan_items    (one CSV row each)
--          │
--          └─── SET NULL ◀── job_schedule.activity_log      (outlives the job)

-- ---------------------------------------------------------------------------
-- The audit trail lets go of `events` first, so the drop below does not take
-- the FK — or, with CASCADE, the log's rows — with it.
-- ---------------------------------------------------------------------------

ALTER TABLE job_schedule.activity_log DROP CONSTRAINT IF EXISTS activity_log_event_id_fkey;

DROP TABLE job_schedule.event_targets;
DROP TABLE job_schedule.events;

-- ---------------------------------------------------------------------------
-- job_schedule.jobs — one job: a date range and the header a planner fills in
-- ---------------------------------------------------------------------------

CREATE TABLE job_schedule.jobs (
  id              bigserial     PRIMARY KEY,

  -- INCLUSIVE on both ends, because that is how a planner states a range
  -- ("1 to 10 October") and how the Table view prints it. Every READ window in
  -- this service is half-open; the overlap predicate in job-repository.ts is
  -- where the two conventions meet.
  start_date      date          NOT NULL,
  end_date        date          NOT NULL,

  -- The plant's IANA zone, resolved from the plan's first machine at write
  -- time. Plan dates and shift boundaries are WALL-CLOCK; this is what turns
  -- them into instants, and it is only ever read by shared/shift.ts.
  time_zone       text          NOT NULL,

  -- Percentages, 0..100. NULL is "not stated", which is different from 0.
  roll_yield      numeric(5,2),
  bag_yield       numeric(5,2),
  wd_today        numeric(5,2),

  -- Headcount per shift.
  rw_personnel    integer,
  tw_personnel    integer,

  -- Overtime per shift, and what that number is COUNTING. The two only mean
  -- something together: "4" is either four hours per group or four person-hours.
  overtime        numeric(8,2),
  overtime_unit   text,

  notes           text,

  -- Who, from the verified token — never the body. Same split as 0001's
  -- events.created_by_*: the id is the Keycloak `sub`, the name is display-only.
  created_by_id   text          NOT NULL,
  created_by_name text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_by_id   text,
  updated_by_name text,
  updated_at      timestamptz,

  CONSTRAINT jobs_range CHECK (end_date >= start_date),
  -- The span cap. Also enforced by the dto with a readable message; this is the
  -- guarantee, and it bounds how large one job's plan can grow.
  CONSTRAINT jobs_range_span CHECK (end_date - start_date < 62),
  CONSTRAINT jobs_roll_yield CHECK (roll_yield IS NULL OR roll_yield BETWEEN 0 AND 100),
  CONSTRAINT jobs_bag_yield CHECK (bag_yield IS NULL OR bag_yield BETWEEN 0 AND 100),
  CONSTRAINT jobs_wd_today CHECK (wd_today IS NULL OR wd_today BETWEEN 0 AND 100),
  CONSTRAINT jobs_rw_personnel CHECK (rw_personnel IS NULL OR rw_personnel >= 0),
  CONSTRAINT jobs_tw_personnel CHECK (tw_personnel IS NULL OR tw_personnel >= 0),
  CONSTRAINT jobs_overtime CHECK (overtime IS NULL OR overtime >= 0),
  CONSTRAINT jobs_overtime_unit CHECK (
    overtime_unit IS NULL OR overtime_unit IN ('HOUR_PER_GROUP', 'PERSON_PER_HOUR')
  ),
  -- BOTH OR NEITHER. A number with no unit is two different amounts of overtime
  -- depending on who reads it; a unit with no number is noise.
  CONSTRAINT jobs_overtime_pair CHECK ((overtime IS NULL) = (overtime_unit IS NULL))
);

-- The Table view: newest first, `id` breaking ties so a page boundary never
-- repeats or skips a job that shares a start date with its neighbour.
CREATE INDEX jobs_list_idx ON job_schedule.jobs (start_date DESC, id DESC);

-- ---------------------------------------------------------------------------
-- job_schedule.job_people — Managers, Foreman, AFA
-- ---------------------------------------------------------------------------

CREATE TABLE job_schedule.job_people (
  -- CASCADE: a person's place on a job is part of the job.
  job_id     bigint  NOT NULL REFERENCES job_schedule.jobs(id) ON DELETE CASCADE,
  role       text    NOT NULL,
  -- The Keycloak user id. The service checks, on every write, that the user
  -- actually holds the realm role configured for `role` — a picker that only
  -- offers holders is not a rule.
  user_id    text    NOT NULL,
  -- FROZEN at write time: the job must keep naming who ran it after that person
  -- is renamed or leaves the realm.
  user_name  text    NOT NULL,

  PRIMARY KEY (job_id, role, user_id),
  CONSTRAINT job_people_role CHECK (role IN ('MANAGER', 'FOREMAN', 'AFA'))
);

-- ---------------------------------------------------------------------------
-- job_schedule.job_plan_items — ONE ROW OF THE UPLOADED CSV
-- ---------------------------------------------------------------------------
--
-- Stored as the planner wrote it — one row per (date, machine, SKU) with three
-- shift flags and ONE target — rather than exploded into a row per shift. The
-- target covers every shift ticked on the row, and exploding it would force a
-- decision about how to divide it that nobody has made.

CREATE TABLE job_schedule.job_plan_items (
  id                bigserial     PRIMARY KEY,
  job_id            bigint        NOT NULL REFERENCES job_schedule.jobs(id) ON DELETE CASCADE,

  -- The BUSINESS date. Shift 3 of this date runs into the next calendar day.
  plan_date         date          NOT NULL,

  -- Master-data ids with their names FROZEN at write time — same rule as 0001's
  -- event_targets: a renamed line must not relabel a plan somebody approved.
  work_center_id    bigint        NOT NULL,
  work_center_name  text          NOT NULL,
  work_unit_id      bigint        NOT NULL,
  work_unit_name    text          NOT NULL,
  product_id        bigint        NOT NULL,
  product_code      text          NOT NULL,
  product_name      text          NOT NULL,

  target            numeric(14,3) NOT NULL,

  -- The machine's FINISH-GOOD unit (its good_output count point's uom), frozen.
  -- NULL when the machine has none: the target then renders as a bare number,
  -- never under a guessed unit.
  uom_code          text,
  uom_name          text,

  shift1            boolean       NOT NULL,
  shift2            boolean       NOT NULL,
  shift3            boolean       NOT NULL,

  CONSTRAINT job_plan_items_target CHECK (target >= 0),
  -- A row with nothing ticked plans nothing. The service skips those rows
  -- before they get here; this is what makes "skipped" the only possible
  -- outcome rather than a convention.
  CONSTRAINT job_plan_items_some_shift CHECK (shift1 OR shift2 OR shift3),
  -- One SKU on one machine on one day, once per job. Two rows for the same
  -- triple would double the target on every screen that sums it.
  CONSTRAINT job_plan_items_unique UNIQUE (job_id, plan_date, work_unit_id, product_id)
);

-- The window reads (Calendar, Gantt) and the conflict check all start from a
-- date range.
CREATE INDEX job_plan_items_date_idx ON job_schedule.job_plan_items (plan_date);
-- The conflict check: "is this machine already planned on this date by another
-- job?" is a probe on exactly this pair.
CREATE INDEX job_plan_items_unit_date_idx
  ON job_schedule.job_plan_items (work_unit_id, plan_date);
-- The line filter.
CREATE INDEX job_plan_items_center_idx ON job_schedule.job_plan_items (work_center_id);

-- ---------------------------------------------------------------------------
-- The audit trail points at jobs now.
-- ---------------------------------------------------------------------------
--
-- Renamed rather than recreated: 0002's reasoning — ON DELETE SET NULL, the
-- frozen label, the NULL-vs-[] distinction in `changes` — carries over word for
-- word, and a recreate would be a second copy of that file to keep in step.
--
-- Any existing rows would point at events that no longer exist, so their ids go
-- NULL: exactly what SET NULL would have done had they been deleted one by one.

UPDATE job_schedule.activity_log SET event_id = NULL WHERE event_id IS NOT NULL;

ALTER TABLE job_schedule.activity_log RENAME COLUMN event_id TO job_id;
ALTER TABLE job_schedule.activity_log RENAME COLUMN event_name TO job_label;
ALTER TABLE job_schedule.activity_log
  RENAME CONSTRAINT activity_log_event_name_not_blank TO activity_log_job_label_not_blank;
ALTER INDEX job_schedule.activity_log_event_idx RENAME TO activity_log_job_idx;

-- NOT CASCADE — see 0002. Deleting a job must not delete the evidence that
-- anyone deleted it.
ALTER TABLE job_schedule.activity_log
  ADD CONSTRAINT activity_log_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES job_schedule.jobs(id) ON DELETE SET NULL;
