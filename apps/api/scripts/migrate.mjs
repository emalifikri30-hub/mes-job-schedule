// Migration runner for the `job_schedule` schema — `pnpm --filter api db:migrate`.
//
// Applies every `src/shared/database/migration/*.sql` file, in filename order,
// that is not already recorded in `job_schedule.schema_migrations`. Each file
// runs inside its own transaction together with the bookkeeping INSERT, so a
// failing migration leaves no partial state and no version row behind.
//
// THE LEDGER IS SCHEMA-QUALIFIED, AND THAT IS NOT A STYLE CHOICE.
//
// This service's tables live in the `job_schedule` schema of the SAME Postgres
// instance that holds mes-oee-monitor's `oee` schema. Both repos descend from
// one template, and the template's runner created a bare `schema_migrations` —
// which resolves to `public.schema_migrations`, a table BOTH would then share.
// Two concrete failures follow from that, and both are silent:
//
//   1. The ledger is keyed by FILENAME. Two template-derived repos naturally
//      ship files with the same names, and the second repo's runner sees the
//      first repo's row, computes `pending = files - applied`, and SKIPS the
//      migration. No error, no output, just a table that never got created.
//
//   2. `SELECT version FROM schema_migrations` returns the other service's
//      history, so "No pending migrations (31 already applied)" reports a count
//      belonging to a repo this one has never seen.
//
// Qualifying the ledger fixes both. It is created inside the same CREATE SCHEMA
// that 0001 makes, so the first run bootstraps it before reading it.
//
// The matching rule for the DDL: EVERY object in every migration file in this
// repo is schema-qualified. `DROP TABLE IF EXISTS comments` — which the template
// shipped as its 0002 — has no schema, so pointed at this instance it would run
// against a database another service owns. That file is deliberately not part of
// this repo: nothing here ever created the template's demo tables, so there is
// nothing to drop.
//
// This is plain `.mjs` rather than TypeScript so it runs on any Node the repo
// supports (>=22.12) without type stripping and without a build step — the same
// reason `instrumentation.mjs` is plain JS.
import "dotenv/config";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const MIGRATION_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/shared/database/migration",
);

// The schema this service owns. Named once, here and in 0001, so the two cannot
// disagree about where the ledger lives.
const SCHEMA = "job_schedule";

const url = process.env.JOB_SCHEDULE_DATABASE_URL;
if (!url) {
  console.error("JOB_SCHEDULE_DATABASE_URL is not set");
  process.exit(1);
}

// No camel transform: this script speaks raw SQL only, and the
// `schema_migrations` columns are already snake_case.
const sql = postgres(url, {
  max: 1,
  onnotice: () => {},
  connection: { application_name: "api-job-schedule-migrate" },
});

async function main() {
  // Bootstraps both the schema and its ledger. Idempotent, and it must run
  // before the SELECT below — on a fresh database neither exists yet.
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await sql.unsafe(`SELECT version FROM ${SCHEMA}.schema_migrations`)).map((row) => row.version),
  );

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`No pending migrations (${applied.size} already applied in ${SCHEMA}).`);
    return;
  }

  for (const file of pending) {
    const ddl = await readFile(path.join(MIGRATION_DIR, file), "utf8");
    // `unsafe` is required because a migration file is a multi-statement script,
    // not a parameterised query. The input is a checked-in file, never user data.
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO ${tx(SCHEMA)}.schema_migrations ${tx({ version: file })}`;
    });
    console.log(`applied ${file}`);
  }

  console.log(`Done — ${pending.length} migration(s) applied to ${SCHEMA}.`);
}

try {
  await main();
} catch (err) {
  console.error("migration failed:", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
