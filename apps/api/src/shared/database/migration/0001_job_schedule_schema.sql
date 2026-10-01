-- The `job_schedule` schema: scheduled PLANNED job windows.
--
-- EVERY OBJECT IS SCHEMA-QUALIFIED. This schema shares a Postgres instance with
-- mes-oee-monitor's `oee` schema, so an unqualified name here resolves through
-- `search_path` into a database another service owns. scripts/migrate.mjs's
-- header explains what that cost the template.

CREATE SCHEMA IF NOT EXISTS job_schedule;

-- Trigram index support for the calendar's "search by event name" filter.
--
-- The search is `name ILIKE '%pump%'` — a LEADING wildcard, which a btree index
-- cannot serve at all. Requires rights to create an extension; a managed
-- instance may need it enabled out of band (see apps/api/README.md).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ONE SERIES. A one-time event is a series with no rule.
--
--   job_schedule.events ──1:N──▶ job_schedule.event_targets
--         │                            (work_center_id, work_unit_id)
--         │
--         └─ rrule NULL ────▶ one occurrence, on first_date
--            rrule set  ────▶ expanded over [from, to) at READ time
--                             (see module/job-event/expand-occurrences.ts)
CREATE TABLE job_schedule.events (
  id                   bigserial   PRIMARY KEY,

  name                 text        NOT NULL,
  description          text,

  -- The master-data reason. Its CATEGORY MUST BE 'PLANNED' — checked by the
  -- service against mes-master-data on every write, because the category is what
  -- decides whether the stop is subtracted from loading time. It cannot be
  -- checked here: the catalogue is another service's table.
  downtime_reason_id   bigint      NOT NULL,
  -- Denormalised label, frozen at write time. Same rule as created_by_name and
  -- the target names below: a renamed reason must not retroactively relabel a
  -- window somebody already scheduled.
  downtime_reason_name text        NOT NULL,

  -- WALL-CLOCK, NOT AN INSTANT.
  --
  -- "Every Monday 08:00" means 08:00 on the PLANT'S clock, forever. Storing a
  -- timestamptz and adding seven days in UTC preserves that only while the
  -- offset never moves — correct today, because Indonesian zones have no DST,
  -- and silently wrong the day a site in another offset is added or a site's
  -- zone is corrected upstream. Every future occurrence would shift by the
  -- offset delta with nothing on screen to say so.
  --
  -- So the three parts are stored separately and combined, in the zone named
  -- here, only at expansion time.
  first_date           date        NOT NULL,
  start_time           time,
  end_time             time,
  all_day              boolean     NOT NULL DEFAULT false,
  -- IANA zone, resolved from master-data (work unit -> work center -> area ->
  -- site) when the event is created.
  time_zone            text        NOT NULL,

  -- RFC 5545 RRULE without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO`.
  -- NULL means the event is one-time, and that is the ONLY thing that means it:
  -- a one-time event can never carry a stale rule and start recurring.
  rrule                text,

  -- THE SERIES' LAST OCCURRENCE, OR NULL FOR "NEVER ENDS".
  --
  -- Denormalised on purpose, and it is what makes the calendar's window filter
  -- an index scan instead of a full expansion of the table. SQL cannot ask when
  -- an RRULE ends: `COUNT=12` carries no date at all, and parsing an RRULE in
  -- SQL to find out is absurd. So the answer is computed ONCE at write time by
  -- the same function that expands the rule at read time — one implementation,
  -- so the stored bound and the expansion can never disagree.
  --
  -- MUST be recomputed by any write that touches first_date, start_time,
  -- time_zone or rrule.
  last_date            date,

  -- WHO. `created_by_id` is the Keycloak `sub` and is the durable identity;
  -- `created_by_name` is preferred_username/name and is display-only, which is
  -- why it is nullable and the id is not. See shared/actor.ts.
  created_by_id        text        NOT NULL,
  created_by_name      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_id        text,
  updated_by_name      text,
  updated_at           timestamptz,

  -- An all-day event has no times; a timed one must have both and must not end
  -- before it starts. Expressed as ONE constraint rather than three so a row can
  -- never satisfy some of the rule: a zero-length or inverted window renders as
  -- an invisible block, which is the failure mode that looks like a missing
  -- event rather than a bad one.
  CONSTRAINT events_all_day_times CHECK (
    (all_day     AND start_time IS NULL     AND end_time IS NULL) OR
    (NOT all_day AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  ),
  CONSTRAINT events_name_not_blank CHECK (length(btrim(name)) > 0)
);

-- The window predicate this index exists for:
--
--   WHERE first_date < $to AND (last_date IS NULL OR last_date >= $from)
--
-- Both halves half-open on the same side as the expander's own window, so an
-- occurrence on the boundary is neither drawn twice nor dropped.
CREATE INDEX events_window_idx ON job_schedule.events (first_date, last_date);

-- Serves `name ILIKE '%...%'`. See the extension note above.
CREATE INDEX events_name_trgm_idx ON job_schedule.events USING gin (name gin_trgm_ops);

-- ONE ROW PER (line, machine) THE EVENT COVERS.
--
-- WHY A JOIN TABLE AND NOT `work_unit_ids bigint[]`
--
-- Three readers need "is machine X covered": the calendar's machine filter, the
-- recurring drawer, and whatever eventually asks this service which windows
-- apply to a machine. An array makes each of them unnest and re-derive it; a row
-- makes it an indexed predicate.
--
-- MACHINES ARE RESOLVED AT CREATE TIME, NOT AT READ TIME. Picking "the whole
-- line" stores the machines on it TODAY. Storing the line alone and expanding it
-- on read would mean a machine added next month silently joins a job
-- window that somebody already approved — the window would grow without anyone
-- editing it.
--
-- The NAMES are frozen here for the same reason, and it also removes every
-- upstream HTTP call from the calendar's hot read path. A machine renamed later
-- keeps the label the person who scheduled the window actually saw.
CREATE TABLE job_schedule.event_targets (
  event_id         bigint NOT NULL REFERENCES job_schedule.events(id) ON DELETE CASCADE,
  work_center_id   bigint NOT NULL,
  work_center_name text   NOT NULL,
  work_unit_id     bigint NOT NULL,
  work_unit_name   text   NOT NULL,

  -- A machine can appear once per event. Selecting two lines that share a
  -- machine is otherwise a duplicate row and a doubled block on the calendar.
  PRIMARY KEY (event_id, work_unit_id)
);

CREATE INDEX event_targets_unit_idx   ON job_schedule.event_targets (work_unit_id);
CREATE INDEX event_targets_center_idx ON job_schedule.event_targets (work_center_id);
