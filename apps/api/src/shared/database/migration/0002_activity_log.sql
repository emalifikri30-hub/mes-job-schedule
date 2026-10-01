-- THE AUDIT TRAIL: who changed which job event, when, and what changed.
--
-- Every object schema-qualified, for the reason 0001's header gives.

CREATE TABLE job_schedule.activity_log (
  id          bigserial   PRIMARY KEY,

  -- NULLABLE, AND `ON DELETE SET NULL` RATHER THAN CASCADE.
  --
  -- This is the single most important line in the file. `event_targets` cascades
  -- because a target is part of the event; an audit row is the opposite — it is
  -- the record that the event EXISTED and was removed. A cascade here would make
  -- deleting an event also delete the evidence that anyone deleted it, which is
  -- precisely the operation an audit trail is for.
  --
  -- The consequence is that `event_id` goes NULL once the event is gone, which is
  -- why the next column exists.
  event_id    bigint      REFERENCES job_schedule.events(id) ON DELETE SET NULL,

  -- FROZEN AT WRITE TIME, so a deleted event still reads as a name rather than as
  -- a dangling id. Also what the feed renders — it never joins back to `events`,
  -- because half its rows could not.
  event_name  text        NOT NULL,

  action      text        NOT NULL,

  -- WHO. `actor_id` is the Keycloak `sub` and is the durable identity;
  -- `actor_name` is preferred_username and is display-only, hence nullable.
  -- Same split, and the same reasoning, as events.created_by_*.
  actor_id    text        NOT NULL,
  actor_name  text,

  at          timestamptz NOT NULL DEFAULT now(),

  -- The field-level diff for an UPDATE: [{field, from, to}, ...]. NULL for a
  -- create or a delete, where there is no "before" and "after" to compare —
  -- an empty array would say "nothing changed", which is a different claim.
  changes     jsonb,

  CONSTRAINT activity_log_action CHECK (action IN ('CREATED', 'UPDATED', 'DELETED')),
  CONSTRAINT activity_log_event_name_not_blank CHECK (length(btrim(event_name)) > 0)
);

-- The feed reads newest-first and pages. `id` breaks ties because `at` defaults
-- to now() and two rows written in the same transaction can share a timestamp to
-- the microsecond — without it, a page boundary can repeat or skip a row.
CREATE INDEX activity_log_feed_idx ON job_schedule.activity_log (at DESC, id DESC);

-- One event's own history. Partial, because the rows whose event has been
-- deleted are never fetched this way — they are only ever read from the feed.
CREATE INDEX activity_log_event_idx
  ON job_schedule.activity_log (event_id, at DESC)
  WHERE event_id IS NOT NULL;
