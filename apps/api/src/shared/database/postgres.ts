import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import postgres from "postgres";

type PostgresDBDeps = {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  debug?: boolean;
  // Surfaces in pg_stat_activity so a DBA can tell which service and which
  // medallion tier is holding a connection.
  applicationName?: string;
  // Opens the session with default_transaction_read_only, so a stray write
  // fails loudly. Defence in depth only — the authoritative protection is a
  // SELECT-only role on the database itself.
  readOnly?: boolean;
};

const MS_PER_SECOND = 1000;

// postgres.js expresses both timeouts in whole seconds, while AppConfig (and the
// `pg` Pool this replaced) express them in milliseconds. Round up so a sub-second
// setting never collapses to 0 — postgres.js reads 0 as "no timeout".
function toSeconds(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / MS_PER_SECOND));
}

function createPostgresDb({
  connectionString,
  max,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  debug,
  applicationName,
  readOnly,
}: PostgresDBDeps) {
  return postgres(connectionString, {
    max,
    idle_timeout: toSeconds(idleTimeoutMillis),
    connect_timeout: toSeconds(connectionTimeoutMillis),
    // Startup parameters, sent once per connection.
    connection: {
      ...(applicationName === undefined ? {} : { application_name: applicationName }),
      ...(readOnly === true ? { default_transaction_read_only: true } : {}),
    },
    // Columns are snake_case in the DB and camelCase in the app. `column.from`
    // maps rows on the way out; `column.to` maps the keys of the `sql(obj)`
    // INSERT/UPDATE helper on the way in. Domain types therefore need no
    // per-query `AS` aliases.
    transform: postgres.camel,
    debug,
  });
}

type PostgresDB = ReturnType<typeof createPostgresDb>;

// The handle `sql.begin(...)` hands its callback. postgres.js names this
// `TransactionSql`; deriving it from `begin` instead does not work, because
// `begin` is overloaded and `Parameters<>` resolves to the last overload only.
//
// The template this came from also declared `GoldDB` and `SilverDB` aliases so
// each repository's deps could say which medallion tier it meant. There is only
// one store here, so `PostgresDB` says everything an alias would.
type TransactionDB = postgres.TransactionSql;

// postgres.js has no official OpenTelemetry instrumentation — the auto-patching
// @opentelemetry/instrumentation-pg only knows node-postgres — so repositories
// wrap each query in this helper to emit the client spans by hand.
const tracer = trace.getTracer("postgres");

async function traced<T>(operation: string, table: string, run: () => Promise<T>): Promise<T> {
  return await tracer.startActiveSpan(
    `${operation} ${table}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "postgresql",
        "db.operation": operation,
        "db.sql.table": table,
      },
    },
    async (span) => {
      try {
        return await run();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// WHAT WAS REMOVED HERE, so nobody re-adds it by reflex.
//
// mes-oee-monitor carries an `asOperator(tx)` helper that stamps a distinct
// `application_name` onto a write's transaction, so its handful of named
// operator mutations can be told apart from its thousands of reads in an audit
// table. It also carries `definedColumns()`, which strips undefined keys before
// they reach the `sql(obj)` helper and become literal NULLs.
//
// Neither came across, and the reason is a fact about THIS service rather than a
// judgement about that one: every row in `job_schedule.jobs` is an operator
// write. There is no pipeline writing beside us, so there is nothing for an
// application_name to distinguish — and the audit trail here (activity_log) is
// written by the mutations themselves, naming the actor from the token, rather
// than read off the session. `definedColumns` had no caller either: this module
// writes whole rows, never patches.
//
// If a session-level audit is ever wanted, that helper is the right shape and
// the two non-obvious parts are worth copying with it: `set_config(..., is_local => true)`
// rather than `SET LOCAL` (SET takes no bind parameters, so the string would have
// to be built by hand — an injection site), and passing the TRANSACTION handle
// rather than the pool (postgres.js pools connections, so a pool-level setting
// leaks into whichever request is handed that connection next).

export { createPostgresDb, traced };
export type { PostgresDB, TransactionDB };
