import { diffDays, isCivilDate } from "@/lib/civil-date";

import type { Job, JobHeader, JobRole, OvertimeUnit } from "@/lib/types";

// THE CREATE / EDIT DIALOG'S DETAILS STEP, as data — the form's text fields and
// the one function that turns them into the header the api takes.
//
// A pure module, so the rules are tested rather than eyeballed. The server
// re-checks every one of them (its dto is the guarantee); these exist so the
// planner hears about a 140% yield on the Details step, next to the field,
// instead of three steps later as a 400.
//
// EVERY NUMERIC FIELD IS OPTIONAL, and blank means NULL — "not planned", which
// is a different statement from 0. A form that coerced blank to 0 would record
// that the job runs with no RW personnel.

// The api's cap: `end_date - start_date < 62`.
const MAX_JOB_DAYS = 62;

type HeaderForm = {
  startDate: string;
  endDate: string;
  rollYield: string;
  bagYield: string;
  wdToday: string;
  rwPersonnel: string;
  twPersonnel: string;
  overtime: string;
  // Always has a value, because a radio group always has one selected. It is
  // SENT only when `overtime` is filled — the api requires both or neither.
  overtimeUnit: OvertimeUnit;
  notes: string;
  managerIds: string[];
  foremanIds: string[];
  afaIds: string[];
};

type HeaderField = keyof HeaderForm;

const PEOPLE_FIELD: Record<JobRole, "managerIds" | "foremanIds" | "afaIds"> = {
  MANAGER: "managerIds",
  FOREMAN: "foremanIds",
  AFA: "afaIds",
};

function blankHeader(range: { from: string; to: string }): HeaderForm {
  return {
    startDate: range.from,
    endDate: range.to,
    rollYield: "",
    bagYield: "",
    wdToday: "",
    rwPersonnel: "",
    twPersonnel: "",
    overtime: "",
    overtimeUnit: "HOUR_PER_GROUP",
    notes: "",
    managerIds: [],
    foremanIds: [],
    afaIds: [],
  };
}

function text(value: number | null): string {
  return value === null ? "" : String(value);
}

function headerFromJob(job: Job): HeaderForm {
  const people = (role: JobRole) => job.people.filter((p) => p.role === role).map((p) => p.userId);
  return {
    startDate: job.startDate,
    endDate: job.endDate,
    rollYield: text(job.rollYield),
    bagYield: text(job.bagYield),
    wdToday: text(job.wdToday),
    rwPersonnel: text(job.rwPersonnel),
    twPersonnel: text(job.twPersonnel),
    overtime: text(job.overtime),
    overtimeUnit: job.overtimeUnit ?? "HOUR_PER_GROUP",
    notes: job.notes ?? "",
    managerIds: people("MANAGER"),
    foremanIds: people("FOREMAN"),
    afaIds: people("AFA"),
  };
}

type HeaderResult =
  | {
      ok: true;
      header: JobHeader;
      people: Pick<HeaderForm, "managerIds" | "foremanIds" | "afaIds">;
    }
  | { ok: false; errors: Partial<Record<HeaderField, string>> };

// A decimal mark of either kind, as the CSV reader accepts: a planner in an
// Indonesian locale types "97,5".
function parseNumber(value: string): number | undefined {
  const t = value.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

function validateHeader(form: HeaderForm): HeaderResult {
  const errors: Partial<Record<HeaderField, string>> = {};

  if (!isCivilDate(form.startDate)) errors.startDate = "Pick a start date";
  if (!isCivilDate(form.endDate)) errors.endDate = "Pick an end date";
  if (errors.startDate === undefined && errors.endDate === undefined) {
    if (form.endDate < form.startDate) {
      errors.endDate = "The end date is before the start date";
    } else if (diffDays(form.startDate, form.endDate) >= MAX_JOB_DAYS) {
      errors.endDate = `A job spans at most ${MAX_JOB_DAYS} days`;
    }
  }

  const percent = (field: "rollYield" | "bagYield" | "wdToday"): number | null => {
    if (form[field].trim() === "") return null;
    const n = parseNumber(form[field]);
    if (n === undefined || n > 100) {
      errors[field] = "A percentage from 0 to 100";
      return null;
    }
    return n;
  };

  const people = (field: "rwPersonnel" | "twPersonnel"): number | null => {
    if (form[field].trim() === "") return null;
    const n = parseNumber(form[field]);
    if (n === undefined || !Number.isInteger(n)) {
      errors[field] = "A whole number of people";
      return null;
    }
    return n;
  };

  const rollYield = percent("rollYield");
  const bagYield = percent("bagYield");
  const wdToday = percent("wdToday");
  const rwPersonnel = people("rwPersonnel");
  const twPersonnel = people("twPersonnel");

  let overtime: number | null = null;
  if (form.overtime.trim() !== "") {
    const n = parseNumber(form.overtime);
    if (n === undefined) errors.overtime = "A number of zero or more";
    else overtime = n;
  }

  const notes = form.notes.trim();
  if (notes.length > 2000) errors.notes = "At most 2000 characters";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    header: {
      startDate: form.startDate,
      endDate: form.endDate,
      rollYield,
      bagYield,
      wdToday,
      rwPersonnel,
      twPersonnel,
      overtime,
      // Both or neither — the api's CHECK constraint, stated here so a stray
      // radio selection on a job with no overtime is not a 400.
      overtimeUnit: overtime === null ? null : form.overtimeUnit,
      notes: notes === "" ? null : notes,
    },
    people: { managerIds: form.managerIds, foremanIds: form.foremanIds, afaIds: form.afaIds },
  };
}

export { MAX_JOB_DAYS, PEOPLE_FIELD, blankHeader, headerFromJob, validateHeader };
export type { HeaderField, HeaderForm, HeaderResult };
