import { metrics } from "@opentelemetry/api";

import type { Counter, Histogram } from "@opentelemetry/api";

// Custom metrics are resolved lazily so they bind to the real MeterProvider
// installed by the OTel SDK — creating an instrument before the SDK starts binds
// it to the no-op provider permanently.
//
// THE `// Alert on:` LINES ARE NOT DECORATION. Every one of them is a real rule
// in `prometheus-alerts.yml`, evaluated by the Prometheus in docker-compose.yml
// and drawn by `grafana/dashboards/job-schedule-service.json`. Adding an
// instrument with an `// Alert on:` line and not adding the rule puts this file
// back to describing an alerting design nobody implemented.
//
// One caveat that bites every time: a HISTOGRAM exports as _bucket / _count /
// _sum, so its annotation must name the bucket series. Counters keep their names
// exactly, `_total` suffix included.

const METER = "core-api";

// Outbound calls to mes-master-data.
//
// Traces already cover the happy path — UndiciInstrumentation emits a CLIENT
// span for every fetch — but a span cannot be alerted on cheaply, and one of
// these failure modes is INVISIBLE over HTTP: a cached list served stale during
// an upstream outage answers 200 with older data.
//
//   outcome = ok | timeout | network_error | http_error | auth_error | parse_error
//           | degraded | truncated
//
// Alert on: rate(master_data_requests_total{outcome!="ok"}[5m]) > 0
let masterDataRequests: Counter | undefined;

function getMasterDataRequestsCounter(): Counter {
  masterDataRequests ??= metrics.getMeter(METER).createCounter("master_data_requests_total", {
    description: "Outbound requests to mes-master-data, labelled by operation and outcome",
  });
  return masterDataRequests;
}

let masterDataDuration: Histogram | undefined;

function getMasterDataDurationHistogram(): Histogram {
  masterDataDuration ??= metrics
    .getMeter(METER)
    .createHistogram("master_data_request_duration_ms", {
      description: "Latency of outbound requests to mes-master-data",
      unit: "ms",
    });
  return masterDataDuration;
}

// Time-zone resolution through the master-data hierarchy.
//
//   outcome = ok | stale | unresolvable
//
// `stale` means the site's zone was served from the last known good value while
// upstream was unreachable. That is the designed behaviour, not a failure — but
// a zone frozen for hours is how a job window starts being written
// against the wrong clock, so it is worth seeing.
//
// Alert on: rate(time_zone_resolutions_total{outcome="unresolvable"}[15m]) > 0
let timeZoneResolutions: Counter | undefined;

function getTimeZoneResolutionsCounter(): Counter {
  timeZoneResolutions ??= metrics.getMeter(METER).createCounter("time_zone_resolutions_total", {
    description: "Site time-zone lookups, labelled by scope and outcome",
  });
  return timeZoneResolutions;
}

// ---------------------------------------------------------------------------
// This service's own domain
// ---------------------------------------------------------------------------

// HOW MANY ROWS ONE WINDOW READ PRODUCED. `read` = shifts | plan.
//
// Exists because the interesting failure is invisible over HTTP: the request
// answers 200 either way. `shifts` rows become Calendar blocks and `plan` rows
// become Gantt bars — every one a DOM node — so a plant whose plans grow past
// what the screens were sized for shows up here before it shows up as a page
// nobody can scroll.
//
// A histogram rather than a counter: the question is "how big is a typical
// request, and how big is the worst one", which a rate cannot answer.
//
// Alert on: histogram_quantile(0.99, rate(job_window_rows_bucket[15m])) > 4000
let jobWindowRows: Histogram | undefined;

function getJobWindowRowsHistogram(): Histogram {
  jobWindowRows ??= metrics.getMeter(METER).createHistogram("job_window_rows", {
    description: "Rows returned by one Calendar (shifts) or Gantt (plan) read",
  });
  return jobWindowRows;
}

// A WINDOW THAT WAS CUT SHORT. `read` = shifts | plan.
//
// Non-zero means somebody was shown an INCOMPLETE schedule. The browser renders
// a banner, so it is not silent to that user — but it is silent to everyone
// else, and it means the row cap is now load-bearing rather than theoretical.
//
// Alert on: rate(job_window_truncations_total[15m]) > 0
let jobWindowTruncations: Counter | undefined;

function getJobWindowTruncationsCounter(): Counter {
  jobWindowTruncations ??= metrics.getMeter(METER).createCounter("job_window_truncations_total", {
    description: "Calendar/Gantt reads whose answer hit the row cap and was truncated",
  });
  return jobWindowTruncations;
}

// HOW LONG RESOLVING ONE UPLOADED PLAN TOOK. `operation` = preview | create |
// update.
//
// Resolution is where a plan meets master data: every line, every machine's
// roster, every line's products and every machine's count points. All cached,
// but a cold cache on a 60-machine plan is 60+ upstream calls, and a slow
// upstream turns the dialog's Preview button into a spinner. Watching the tail
// is how that is noticed before a planner gives up and re-uploads.
//
// Alert on: histogram_quantile(0.95, rate(job_plan_resolve_duration_ms_bucket[15m])) > 10000
let jobResolveDuration: Histogram | undefined;

function getJobResolveDurationHistogram(): Histogram {
  jobResolveDuration ??= metrics.getMeter(METER).createHistogram("job_plan_resolve_duration_ms", {
    description: "Latency of resolving an uploaded job plan against master data",
    unit: "ms",
  });
  return jobResolveDuration;
}

// OPERATOR WRITES. `operation` = create | update; `outcome` = ok | rejected |
// conflict.
//
// Every row in job_schedule.jobs was entered by a named person through this API
// — there is no pipeline filling these tables — so this counter IS the write
// traffic of the service, not a sample of it. `rejected` and `conflict` are a
// planner being told no, which is the system working; they are counted so a
// template change that makes every upload fail is visible as a shape, not
// reported one planner at a time.
let jobWrites: Counter | undefined;

function getJobWritesCounter(): Counter {
  jobWrites ??= metrics.getMeter(METER).createCounter("job_writes_total", {
    description: "Job mutations, labelled by operation and outcome",
  });
  return jobWrites;
}

// Master-data CACHE behaviour. `outcome` = hit | miss | stale | backoff.
//
// `stale` is the one to watch: it means upstream was unreachable and the last
// known good list was served instead. That is the designed behaviour and it is
// why a picker degrades to a slightly old catalogue rather than an empty one —
// but a catalogue frozen for hours is how an operator ends up choosing a reason
// that no longer exists.
//
// Alert on: rate(master_data_cache_total{outcome="stale"}[15m]) > 0
let masterDataCache: Counter | undefined;

function getMasterDataCacheCounter(): Counter {
  masterDataCache ??= metrics.getMeter(METER).createCounter("master_data_cache_total", {
    description: "Master-data reference cache outcomes, labelled by resource and outcome",
  });
  return masterDataCache;
}

// Outbound calls to Keycloak's admin API — the job dialog's people pickers.
//
//   outcome = ok | timeout | network_error | http_error | auth_error | parse_error
//           | truncated
//
// `auth_error` is the one this exists for. It is what an unprovisioned service
// account looks like (no realm-management view-users), and it only ever
// surfaces when somebody opens the Create Job dialog.
//
// Alert on: rate(keycloak_requests_total{outcome!="ok"}[5m]) > 0
let keycloakRequests: Counter | undefined;

function getKeycloakRequestsCounter(): Counter {
  keycloakRequests ??= metrics.getMeter(METER).createCounter("keycloak_requests_total", {
    description: "Outbound Keycloak admin-API requests, labelled by operation and outcome",
  });
  return keycloakRequests;
}

// The role-member cache. Same outcomes as master_data_cache_total, and `stale`
// means the pickers are offering a list from before Keycloak became unreachable.
let keycloakCache: Counter | undefined;

function getKeycloakCacheCounter(): Counter {
  keycloakCache ??= metrics.getMeter(METER).createCounter("keycloak_cache_total", {
    description: "Keycloak role-member cache outcomes",
  });
  return keycloakCache;
}

// ---------------------------------------------------------------------------
// Operator authorization
// ---------------------------------------------------------------------------
//
// The role gate ships DARK — every role name in AppConfig.auth.roles is
// undefined unless an operator sets one, in which case requireRole checks
// nothing (see shared/actor.ts and TODOS.md §3). These two exist so that turning
// one ON is observable BEFORE somebody discovers it by being refused.
//
// The rollout trap they exist for: a role name Keycloak does not actually emit
// 403s only the WRITE paths. Reads keep working, the calendar looks completely
// healthy, and the failure surfaces the first time anybody tries to schedule
// job. Set one role, have a real operator exercise that one route, and
// watch the denials counter before setting the next.
//
// Alert on: rate(operator_authorization_denials_total[5m]) > 0
let operatorDenials: Counter | undefined;

function getOperatorAuthorizationDenialsCounter(): Counter {
  operatorDenials ??= metrics
    .getMeter(METER)
    .createCounter("operator_authorization_denials_total", {
      description: "Operator mutations refused by the role gate, labelled by operation and role",
    });
  return operatorDenials;
}

let operatorGrants: Counter | undefined;

function getOperatorAuthorizationGrantsCounter(): Counter {
  operatorGrants ??= metrics.getMeter(METER).createCounter("operator_authorization_grants_total", {
    description: "Operator mutations admitted by the role gate, labelled by operation and role",
  });
  return operatorGrants;
}

export {
  getJobResolveDurationHistogram,
  getJobWindowRowsHistogram,
  getJobWindowTruncationsCounter,
  getJobWritesCounter,
  getKeycloakCacheCounter,
  getKeycloakRequestsCounter,
  getMasterDataCacheCounter,
  getMasterDataDurationHistogram,
  getMasterDataRequestsCounter,
  getOperatorAuthorizationDenialsCounter,
  getOperatorAuthorizationGrantsCounter,
  getTimeZoneResolutionsCounter,
};
