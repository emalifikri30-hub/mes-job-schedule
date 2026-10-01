import type { ShiftNumber } from "@/lib/types";

// THE SHIFTS, AS LABELS ONLY.
//
// The boundaries are hardcoded by the requirement and OWNED BY THE SERVER
// (apps/api/src/shared/shift.ts), which is the only place that turns
// `plan_date + shift + zone` into instants. This file mirrors the numbers and
// the wall-clock text a person reads, and nothing here may be used to build an
// instant — a second copy of that arithmetic is a second answer to "when does
// Friday's shift 3 end", and the two would disagree the day the boundaries move
// (TODOS: configurable shifts).
//
//   S1  07:00 – 15:00
//   S2  15:00 – 23:00
//   S3  23:00 – 07:00 NEXT DAY   <- still Friday's shift, on Saturday's clock

const SHIFTS: readonly ShiftNumber[] = [1, 2, 3];

const SHIFT_HOURS: Record<ShiftNumber, string> = {
  1: "07:00 – 15:00",
  2: "15:00 – 23:00",
  3: "23:00 – 07:00",
};

function shiftLabel(shift: ShiftNumber): string {
  return `Shift ${shift}`;
}

export { SHIFTS, SHIFT_HOURS, shiftLabel };
