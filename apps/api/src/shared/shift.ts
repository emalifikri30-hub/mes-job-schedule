import { fromZonedTime } from "date-fns-tz";

import type { ShiftNumber } from "../module/job/job.js";

// THE THREE SHIFTS, AND THE ONLY PLACE A PLAN DATE BECOMES AN INSTANT.
//
// Hardcoded by the requirement for now (TODOS: configurable shifts). Stored as
// WALL-CLOCK boundaries in the plant's zone, never as offsets from UTC:
//
//        business date D                          D + 1
//   ─────────┬────────────────────┬──────────────┬──────┬────────────
//          07:00               15:00          23:00  00:00        07:00
//            │◀──── shift 1 ────▶│◀── shift 2 ─▶│◀────── shift 3 ──────▶│
//
// A plan row's `plan_date` is the BUSINESS date, so shift 3 of Friday is Friday
// 23:00 to SATURDAY 07:00. That is the one boundary in this module that crosses
// midnight, and it is why `endsOnNextDay` exists rather than the end being
// derived by comparing clock strings.
//
// WHY INSTANTS ARE BUILT HERE AND NOT IN THE BROWSER: the browser does calendar
// arithmetic in UTC fields only (web lib/civil-date.ts) and cannot know when
// 07:00 happens in Jakarta without a zone database the server already has. The
// Calendar read hands it finished instants. Adding 8 hours to a UTC midnight
// would be correct while the plant's offset never moves — which is today, as no
// Indonesian zone observes DST — and silently an hour off the day one does. The
// suite runs under America/New_York so that bug class fails in CI.

type ShiftDefinition = {
  shift: ShiftNumber;
  start: string;
  end: string;
  endsOnNextDay: boolean;
};

const SHIFTS: readonly ShiftDefinition[] = [
  { shift: 1, start: "07:00:00", end: "15:00:00", endsOnNextDay: false },
  { shift: 2, start: "15:00:00", end: "23:00:00", endsOnNextDay: false },
  { shift: 3, start: "23:00:00", end: "07:00:00", endsOnNextDay: true },
];

const MS_PER_DAY = 86_400_000;

// Civil-date arithmetic in UTC fields only — exact for the calendar, and never
// used to build an instant.
function nextCivilDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

function shiftInstants(
  businessDate: string,
  shift: ShiftNumber,
  timeZone: string,
): { startsAt: Date; endsAt: Date } {
  const definition = SHIFTS[shift - 1]!;
  const endDate = definition.endsOnNextDay ? nextCivilDate(businessDate) : businessDate;
  return {
    startsAt: fromZonedTime(`${businessDate}T${definition.start}`, timeZone),
    endsAt: fromZonedTime(`${endDate}T${definition.end}`, timeZone),
  };
}

export { SHIFTS, nextCivilDate, shiftInstants };
export type { ShiftDefinition };
