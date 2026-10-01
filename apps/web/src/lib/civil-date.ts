// CIVIL DATES — a calendar date with no time and no zone, as `YYYY-MM-DD`.
//
// WHY THIS FILE EXISTS AT ALL
//
// Every date bug in a calendar comes from the same move: taking a date the user
// sees ("21 Sep"), feeding it to `new Date()`, and getting back an instant that
// depends on the machine's zone. `new Date("2026-09-21")` is midnight UTC;
// `new Date(2026, 8, 21)` is midnight LOCAL. In Jakarta the first is 07:00 on
// the 21st, so `.getDate()` answers 21 and nothing looks wrong. Move the same
// code to a server in UTC-5 and it answers 20.
//
// So: the functions here parse into a UTC instant and read UTC fields ONLY.
// That makes them exact for calendar arithmetic and useless for anything else,
// which is the point — they cannot be misused to build a wall-clock instant.
// Converting a civil date plus a wall-clock time into a real instant is a
// SEPARATE job that needs a zone, and it belongs to the server — a shift's
// instants are built from `plan_date + shift + time_zone` in
// apps/api/src/shared/shift.ts and arrive here already resolved.
//
//   "2026-09-21"  ──parseCivil──▶ Date @ 2026-09-21T00:00:00Z  (a KEY, not a time)
//                 ◀──toCivil────
//
// The round trip is lossless and zone-independent. Nothing else in the browser
// does date arithmetic.

const MS_PER_DAY = 86_400_000;

// Short English month names, indexed 0-11. Lives here rather than beside any one
// renderer because four of them print a month and a fifth copy is how "Sept"
// ends up on one screen and "Sep" on the next.
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Indexed by dayOfWeek(): 0 = Sunday.
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CIVIL_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCivilDate(value: string): boolean {
  if (!CIVIL_RE.test(value)) return false;
  const parsed = parseCivil(value);
  // `2026-13-01` matches the shape but parses to an Invalid Date, whose
  // toISOString() THROWS rather than returning something unequal — so the
  // round-trip check below needs this guard ahead of it, not instead of it.
  if (Number.isNaN(parsed.getTime())) return false;
  // Rejects 2026-02-30, which parses fine and silently becomes 2026-03-02.
  return toCivil(parsed) === value;
}

// Parses to midnight UTC. The result is an ordering/arithmetic key, never a
// wall-clock instant — see the header.
function parseCivil(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toCivil(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  return toCivil(new Date(parseCivil(value).getTime() + days * MS_PER_DAY));
}

// Whole days between two civil dates, `to - from`. Exact: both operands are
// midnight UTC, and UTC has no DST, so no day is 23 or 25 hours long here.
function diffDays(from: string, to: string): number {
  return Math.round((parseCivil(to).getTime() - parseCivil(from).getTime()) / MS_PER_DAY);
}

// 0 = Sunday … 6 = Saturday.
function dayOfWeek(value: string): number {
  return parseCivil(value).getUTCDay();
}

function year(value: string): number {
  return parseCivil(value).getUTCFullYear();
}

// 1-12, NOT the 0-11 that `Date` uses. Every caller here wants the human month,
// and returning the machine one is how an off-by-one reaches a label.
function month(value: string): number {
  return parseCivil(value).getUTCMonth() + 1;
}

function dayOfMonth(value: string): number {
  return parseCivil(value).getUTCDate();
}

// Clamps, so "31 Jan + 1 month" is 28/29 Feb rather than rolling into March.
// Used only for view navigation (next/previous month).
function addMonths(value: string, months: number): string {
  const d = parseCivil(value);
  const targetMonth = d.getUTCMonth() + months;
  const first = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return toCivil(
    new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)),
    ),
  );
}

function startOfMonth(value: string): string {
  const d = parseCivil(value);
  return toCivil(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
}

function startOfYear(value: string): string {
  return `${year(value)}-01-01`;
}

// Back to the most recent `weekStartsOn` (0 = Sunday). Returns `value` itself
// when it already is that day.
function startOfWeek(value: string, weekStartsOn = 0): string {
  const shift = (dayOfWeek(value) - weekStartsOn + 7) % 7;
  return addDays(value, -shift);
}

function daysInMonth(value: string): number {
  const d = parseCivil(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

// Today, in a given IANA zone, as a civil date.
//
// `en-CA` because its short date format IS `YYYY-MM-DD`; this is the one place
// the browser's clock is read, and it is read THROUGH a zone so the answer is
// the plant's today rather than the viewer's.
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// "Wed, 23 Sep 2026" — the long form the Table and the Create Job confirmation
// print. Built from the civil fields rather than Intl.DateTimeFormat, because a
// formatter handed `parseCivil(value)` would render it in the BROWSER's zone
// and print the 22nd for anybody west of Greenwich.
function formatCivilLong(value: string): string {
  return `${WEEKDAY_SHORT[dayOfWeek(value)]}, ${dayOfMonth(value)} ${MONTH_NAMES[month(value) - 1]} ${year(value)}`;
}

// A job's range as the Table shows it: one date when the job is one day long,
// "Wed, 23 Sep 2026 – Fri, 25 Sep 2026" otherwise. Both ends INCLUSIVE — this is
// the planner's range, not a half-open query window.
function formatCivilRange(from: string, to: string): string {
  return from === to ? formatCivilLong(from) : `${formatCivilLong(from)} – ${formatCivilLong(to)}`;
}

// DD/MM/YYYY, the form the plan CSV carries.
function toDayMonthYear(value: string): string {
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

export {
  MONTH_NAMES,
  WEEKDAY_SHORT,
  addDays,
  addMonths,
  dayOfMonth,
  dayOfWeek,
  daysInMonth,
  diffDays,
  formatCivilLong,
  formatCivilRange,
  isCivilDate,
  month,
  parseCivil,
  startOfMonth,
  startOfWeek,
  startOfYear,
  toCivil,
  toDayMonthYear,
  todayIn,
  year,
};
